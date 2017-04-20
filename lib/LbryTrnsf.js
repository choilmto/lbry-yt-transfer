'use strict';
const logger = require('winston');
const ytdl = require('youtube-dl');
const google = require('googleapis');
const youtube = google.youtube('v3');
const sqlite3 = require('sqlite3');
const Bottleneck = require('bottleneck');
const db = new sqlite3.Database('db.sqlite');
const request = require('request');
const path = require('path');
const fs = require('fs');
let connection;
let API_KEY;
let limiter;
//
class LbryTrnsf {
  constructor(config) {
    logger.info('[LbryTrnsf] : Initializing Modules, booting the spaceship...');
    db.run('CREATE TABLE IF NOT EXISTS videos (videoid TEXT UNIQUE, downloaded INT, uploaded INT, channelid TEXT, fulltitle TEXT, description TEXT, thumbnail BLOB, data BLOB)');
    this.config = config;
    this.init();
  }

  init() {
    API_KEY = this.config.get('youtube_api').key;
    limiter = new Bottleneck(this.config.get('limiter').concurrent_d, 1000);
    logger.info('[LbryTrnsf] : Program is initialized!');

  }
}

// Functions here...
LbryTrnsf.prototype.resolveChannelPlaylist = function (channelID) { // Function to get the playlist with all videos from the selected channel(by id)
  return new Promise(function (success, reject) {
    logger.info('[LbryTrnsf] : Getting list of videos for channel %s', channelID);

    request('https://www.googleapis.com/youtube/v3/channels?part=contentDetails,brandingSettings&id=' + channelID + '&key=' + API_KEY, (error, response, body) => {
      if (error) {
        logger.debug('[LbryTrnsf][ERROR] :', error);
        return reject(error);
      } // Print the error if one occurred
      if (typeof JSON.parse(body).items[0].contentDetails.relatedPlaylists.uploads !== 'undefined') {
        const pl = JSON.parse(body).items[0].contentDetails.relatedPlaylists.uploads;
        logger.info('[LbryTrnsf] : Got the playlist for the channel %s: %s , saving down metadata for the videos....', channelID, pl);
        getChannelVids(channelID, pl, false, '').then(result => success(channelID)).catch(err => reject(err)); // Calls the getChannelVids function and keeps going....
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
    if (typeof nextPageToken === 'undefined') {
      requestBody.pageToken = nextPageToken;
    }

    youtube.playlistItems.list(requestBody,
      (err, response) => {
        if (err) {
          return reject(err);
        }

        const responsed = response.items;
        db.serialize(() => {
          const stmt = db.prepare('INSERT OR IGNORE INTO videos VALUES (?,?,?,?,?,?,?,?); ');
          responsed.forEach((entry, i) => {
            stmt.run(entry.snippet.resourceId.videoId, 0, 0, chid, entry.snippet.title, entry.snippet.description, JSON.stringify(entry.snippet.thumbnails.standard), JSON.stringify(entry.snippet));
          });
          stmt.finalize();

          logger.info('[LbryTrnsf] : Saved down %s videos owned by channel %s', responsed.length, chid);
          if (response.hasOwnProperty('nextPageToken')) {
            logger.info('[LbryTrnsf] : More videos, going to next page...');
            getChannelVids(chid, playlistid, true, response.nextPageToken);
          }
          else {
            // NO MORE VIDEOS TO SAVE, CALL DOWNLOAD FUNCTION HERE
            logger.info('[LbryTrnsf] : Done saving to db...');
            downChannelVids(chid)
              .then(result => {
                logger.info('downloaded all videos and returning from getChannelVids: ' + result);
                success(chid)
              })
              .catch(err => reject(err));
          }
        });
      }
    );
  });
}

function downChannelVids(chid) { // Downloads all the videos from the playlist and saves them to the db and on disk for lbry upload.
  return new Promise(function (success, reject) {
    let query = 'SELECT videoid,channelid,fulltitle,description FROM videos WHERE downloaded = 0 AND channelid = \'' + chid + '\'';
    let callback = function (err, row) {
      if (err) {
        return reject(err);
      }
      logger.info('submitting for download');
      logger.info(row);
      limiter.submit(dlvid, chid, row, null);
    };
    let completion = function (error, count) {
      if (count === 0) {
        success('All videos were already downloaded!');
      }
    };

    db.each(query, callback, completion);

    limiter.on('idle', () => {
      logger.info('Downloaded all the videos for the channel!');
      success('Downloaded all the videos for the channel!');
    });
  });
}

function dlvid(chid, row, cb) {
  const vidDir = '/mnt/bigdrive/videos/';
  const dir = vidDir + row.channelid + '/';
  const output = dir + row.videoid + '.mp4';
  let downloaded = 0;

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

  const video = ytdl('https://www.youtube.com/watch?v=' + row.videoid,

    // Optional arguments passed to youtube-dl.
    ['--format=best'],
    // Start will be sent as a range header
    {
      start: downloaded,
      cwd: __dirname,
      maxBuffer: 1000*1024 //Simple hotfix for buffers
    });

  // Will be called when the download starts.
  video.on('info', info => {
    logger.info('[LbryTrnsf] : Download started for video %s', row.videoid);
  });

  video.pipe(fs.createWriteStream(output, {
    flags: 'a'
  }));

  // Will be called when the download is or was (already) completed.
  video.on('complete', info => {
    'use strict';
    logger.info('[LbryTrnsf] : Download was already completed for video %s', row.videoid);
    cb();
    // Db edit downloaded to 1
    db.run('UPDATE videos SET downloaded=1 WHERE videoid=\'' + row.videoid + '\'');
  });

  //this is not necessary, it would execute the query for a second time
  video.on('end', () => {
    logger.info('[LbryTrnsf] : Download finished for video %s', row.videoid);
    cb();
    // Db edit downloaded to 1
    db.run('UPDATE videos SET downloaded=1 WHERE videoid=\'' + row.videoid + '\'');
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
      console.log(error);
    } else {
      db.run("UPDATE videos SET thumbnail='" + body.url + "' WHERE videoid='" + v_id + "'");
    }
  });
}

module.exports = LbryTrnsf;
