'use strict';
const logger = require('winston');
const ytdl = require('youtube-dl');       // https://www.npmjs.com/package/youtube-dl
const google = require('googleapis');
const youtube = google.youtube('v3');
const sqlite3 = require('sqlite3');
const Bottleneck = require('bottleneck'); // https://www.npmjs.com/package/bottleneck
const db = new sqlite3.Database('db.sqlite');
const request = require('request');
const path = require('path');
const fs = require('fs');
let connection;
let API_KEY;
let limiter;
let _limit;

class YoutubeDownload {
  constructor(config) {
    logger.info('[YoutubeDownload] : Initializing Modules, booting the spaceship...');
    //generate the database if not previously generated
    db.run('CREATE TABLE IF NOT EXISTS videos (videoid TEXT UNIQUE, downloaded INT, channelid TEXT, fulltitle TEXT, description TEXT, thumbnail BLOB, data BLOB)');
    //store the configs passed through the constructor
    this.config = config;
    //start the engine
    this.init();
  }

  init() {
    //grab the API key for accessing youtube
    API_KEY = this.config.get('youtube_api').key;
    //initializes the limiter for when tasks are run concurrently
    //maxConcurrentRequests -- minimumWaitTimeBeforeNewRequest
    limiter = new Bottleneck(this.config.get('limiter').concurrent_d, 1000);
    logger.info('[YoutubeDownload] : Downloader is initialized!');
  }
}

// Function to get the playlist with all videos from the selected channel(by id)
YoutubeDownload.prototype.setLimit = function (limit) {
  _limit = limit;
};

// Function to get the playlist with all videos from the selected channel(by id)
YoutubeDownload.prototype.resolveChannelPlaylist = function (channelID) {
  return new Promise(function (success, reject) {
    logger.info('[YoutubeDownload] : Getting list of videos for channel %s', channelID);

    request('https://www.googleapis.com/youtube/v3/channels?part=contentDetails,brandingSettings&id=' + channelID + '&key=' + API_KEY, (error, response, body) => {
      if (error) {
        logger.debug('[YoutubeDownload][ERROR] :', error);
        return reject(error);
      } // Print the error if one occurred
      if (typeof JSON.parse(body).items[0].contentDetails.relatedPlaylists.uploads !== 'undefined') {
        const playlistId = JSON.parse(body).items[0].contentDetails.relatedPlaylists.uploads;
        logger.info('[YoutubeDownload] : Got the playlist for the channel %s: %s , saving down metadata for the videos....', channelID, playlistId);

        // Calls the getChannelVids function and keeps going....
        return getChannelVids(channelID, playlistId)
          //.then(result => success(channelID))
          .then(success)
          .catch(reject);
      }
      else {
        return reject('No uploads found');
      }
    });
  });
};

function getChannelVids(chid, playlistid, nextPageToken) { // Gets all the videos metadata and inserts them into the db...
  return new Promise(function (success, reject) {
    let requestBody = {
      auth: API_KEY,
      part: 'snippet',
      playlistId: playlistid,
      maxResults: 50
    };
    if (typeof nextPageToken !== 'undefined') {
      requestBody.pageToken = nextPageToken;
    }

    youtube.playlistItems.list(requestBody,
      (err, response) => {
        if (err) {
          return reject(err);
        }

        const responsed = response.items;
        db.serialize(() => {
          const stmt = db.prepare('INSERT OR IGNORE INTO videos VALUES (?,?,?,?,?,?,?); ');
          responsed.forEach((entry, i) => {
            stmt.run(entry.snippet.resourceId.videoId, 0, chid, entry.snippet.title, entry.snippet.description, 'unprocessed', JSON.stringify(entry.snippet));
          });
          stmt.finalize();

          logger.info('[YoutubeDownload] : Saved down %s videos owned by channel %s', responsed.length, chid);
          if (response.hasOwnProperty('nextPageToken')) {
            logger.info('[YoutubeDownload] : More videos, going to next page...');
            //logger.info('nextToken: %s', response.nextPageToken);
            return getChannelVids(chid, playlistid, response.nextPageToken)
              .then(success)
              .catch(reject);
          }
          else {
            // NO MORE VIDEOS TO SAVE, CALL DOWNLOAD FUNCTION HERE
            logger.info('[YoutubeDownload] : Done saving to db...');

            //download the videos of a channel
            return downChannelVids(chid)
              //all videos are downloaded
              .then(success)
              //something went wrong while downloading
              .catch(reject);
          }
        });
      }
    );
  });
}

// Downloads all the videos from the playlist and saves them to the db and on disk for lbry upload.
function downChannelVids(channelId) {
  return new Promise(function (success, reject) {
    let query = 'SELECT videoid,channelid,fulltitle,description FROM videos WHERE downloaded = 0 AND channelid = \'' + channelId + '\'';
    let callback = function (err, row) {
      if (err) {
        return reject(err);
      }
      logger.info('[%s] submitting for download: %s', new Date().toISOString(), row.videoid);
      //logger.info(row);
      limiter.schedule(dlvid, channelId, row, success).catch(logger.error);
    };

    let completion = function (error, count) {
      if (count === 0) {
        logger.info('All videos were already downloaded for channel %s!', channelId);
        return success(channelId);
      }
    };

    db.each(query, callback, completion);

    limiter.on('idle', () => {
      logger.info('Downloaded all the videos for the channel!');
      return success(channelId);
    });
  });
}

function dlvid(chid, row, cb) {
  return new Promise(function (success, reject) {
    const vidDir = '/mnt/bigdrive/videos/';
    const dir = vidDir + row.channelid + '/';
    const output = dir + row.videoid + '.mp4';
    let downloaded = 0;
    let failureDownloading = false;

    if (!fs.existsSync(vidDir)) {
      fs.mkdirSync(vidDir);
    }

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir);
    }

    if (fs.existsSync(output)) {
      downloaded = fs.statSync(output).size;
    }

    savethumb(row.videoid); //Call function to download thumbnail into bucket!

    const video = ytdl(
      'https://www.youtube.com/watch?v=' + row.videoid,
      // Optional arguments passed to youtube-dl.
      ['--format=best'],
      // Start will be sent as a range header
      {
        start: downloaded,
        cwd: __dirname,
        maxBuffer: Infinity //Simple hotfix for buffers
      });

    // Will be called when the download starts.
    video.on('info', info => {
      logger.info('[%s][YoutubeDownload] : Download started for video %s', new Date().toISOString(), row.videoid);
    });

    video.pipe(fs.createWriteStream(output, {
      flags: 'a'
    }));

    // Will be called when the download is or was (already) completed.
    video.on('complete', info => {
      if (!failureDownloading) {
        logger.info('[YoutubeDownload] : Download was already completed for video %s', row.videoid);
        // Db edit downloaded to 1
        db.run('UPDATE videos SET downloaded=1 WHERE videoid=\'' + row.videoid + '\'');
        return success();
      }
    });

    //called when a video finishes downloading
    video.on('end', () => {
      if (!failureDownloading) {
        logger.info('[%s][YoutubeDownload] : Download finished for video %s', new Date().toISOString(), row.videoid);
        // Db edit downloaded to 1
        db.run('UPDATE videos SET downloaded=1 WHERE videoid=\'' + row.videoid + '\'');
        return success();
      }
    });

    video.on('error', (e) => {
      failureDownloading = true;
      logger.error("[YoutubeDownload] : There was an error downloading video %s: %s ", row.videoid, e);
      return success(); //the app hangs if this returns reject
      //return reject(e);
    });
  });
}

function savethumb(v_id) {
  request.put({
    url: 'https://jgp4g1qoud.execute-api.us-east-1.amazonaws.com/prod/thumbnail',
    method: 'PUT',
    json: {
      videoid: v_id
    }
  }, function (error, response, body) {
    if (error) {
      logger.error(error);
    } else {
      if (body.error === 0)
        db.run("UPDATE videos SET thumbnail='" + body.url + "' WHERE videoid='" + v_id + "'");
      else {
        logger.error("failed to store a thumbnail. Details: %s", body);
        db.run("UPDATE videos SET thumbnail='failed' WHERE videoid='" + v_id + "'");
      }
    }
  });
}

module.exports = YoutubeDownload;