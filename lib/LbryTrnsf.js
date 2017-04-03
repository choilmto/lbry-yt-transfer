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
LbryTrnsf.prototype.resolveChannelPlaylist = function (chid) { // Function to get the playlist with all videos from the selected channel(by id)
  return new Promise(function (success, reject) {
    logger.info('[LbryTrnsf] : Getting list of videos for channel %s', chid);

    request('https://www.googleapis.com/youtube/v3/channels?part=contentDetails,brandingSettings&id=' + chid + '&key='+API_KEY, (error, response, body) => {
      if (error) {
        logger.debug('[LbryTrnsf][ERROR] :', error);
        return reject(error);
      } // Print the error if one occurred
      if (typeof JSON.parse(body).items[0].contentDetails.relatedPlaylists.uploads !== 'undefined') {
        const pl = JSON.parse(body).items[0].contentDetails.relatedPlaylists.uploads;
        logger.info('[LbryTrnsf] : Got the playlist for the channel %s: %s , saving down metadata for the videos....', chid, pl);
        getChannelVids(chid, pl, false, '').then(result => success(chid)).catch(err => reject(err)); // Calls the getChannelVids function and keeps going....
      }
      else {
        return reject('No uploads found');
      }
    });
  });
};

function getChannelVids(chid, playlistid, newpg, pgtoken) { // Gets all the videos metadata and inserts them into the db...
  return new Promise(function (success, reject) {
    if (!newpg) { // If its a addon request for items or not
      youtube.playlistItems.list({
        auth: API_KEY,
        part: 'snippet',
        playlistId: playlistid,
        maxResults: 50
      },
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
          });
          logger.info('[LbryTrnsf] : Saved down %s videos owned by channel %s', responsed.length, chid);
          if (typeof response.nextPageToken !== 'undefined') {
            logger.info('[LbryTrnsf] : More videos, going to next page...');
            getChannelVids(chid, playlistid, true, response.nextPageToken);
          }
          else {
            // NO MORE VIDEOS TO SAVE, CALL DOWNLOAD FUNCTION HERE
            logger.info('[LbryTrnsf] : Done saving to db...');
            downChannelVids(chid).then(result => success(chid)).catch(err => reject(err));
          }
        }
      );
    }
    if (newpg) { // Fetch the next page and save it aswell
      youtube.playlistItems.list({
        auth: API_KEY,
        part: 'snippet',
        playlistId: playlistid,
        maxResults: 50,
        pageToken: pgtoken
      },
        (err, response) => {
          const responsed = response.items;
          db.serialize(() => {
            const stmt = db.prepare('INSERT OR IGNORE INTO videos VALUES (?,?,?,?,?,?,?,?); ');
            responsed.forEach((entry, i) => {
              stmt.run(entry.snippet.resourceId.videoId, 0, 0, chid, entry.snippet.title, entry.snippet.description, JSON.stringify(entry.snippet.thumbnails.standard), JSON.stringify(entry.snippet));
            });
            stmt.finalize();
          });
          logger.info('[LbryTrnsf] : Saved down %s videos owned by channel %s', responsed.length, chid);
          if (typeof response.nextPageToken !== 'undefined') {
            logger.info('[LbryTrnsf] : More videos, going to next page...');
            getChannelVids(chid, playlistid, true, response.nextPageToken);
          }
          else {
            logger.info('[LbryTrnsf] : Done saving to db...');
            downChannelVids(chid).then(result => success(chid)).catch(err => reject(err));
          }
        }
      );
    }
  });
}

function downChannelVids(chid) { // Downloads all the videos from the playlist and saves them to the db and on disk for lbry upload.
  return new Promise(function (success, reject) {
    db.each('SELECT videoid,channelid,fulltitle,description FROM videos WHERE downloaded = 0 AND channelid = \'' + chid + '\'', (err, row) => {
      if (err) {
        return reject(err);
      }
      console.log('submitting');
      console.log(row);
      limiter.submit(dlvid, chid, row, null);
    });
    limiter.on('idle', () => {
      logger.info('Downloaded all the videos for the channel!');
      success('Downloaded all the videos for the channel!');
    });
  });
}

function dlvid(chid, row, cb) {
  const vidDir = process.cwd() + '/videos/';
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

  const video = ytdl('https://www.youtube.com/watch?v=' + row.videoid,

    // Optional arguments passed to youtube-dl.
    ['--format=best'],
    // Start will be sent as a range header
    {
      start: downloaded,
      cwd: __dirname
    });

  // Will be called when the download starts.
  video.on('info', info => {
    logger.info('[LbryTrnsf] : Download started for video %s', row.videoid);
  });

  video.pipe(fs.createWriteStream(output, {
    flags: 'a'
  }));

  // Will be called if download was already completed and there is nothing more to download.
  video.on('complete', info => {
    'use strict';
    logger.info('[LbryTrnsf] : Download finished for video %s', row.videoid);
    cb();
    // Db edit downloaded to 1
    db.run('UPDATE videos SET downloaded=1 WHERE videoid=\'' + row.videoid + '\'');
  });

  video.on('end', () => {
    logger.info('[LbryTrnsf] : Download finished for video %s', row.videoid);
    cb();
    // Db edit downloaded to 1
    db.run('UPDATE videos SET downloaded=1 WHERE videoid=\'' + row.videoid + '\'');
  });
}

module.exports = LbryTrnsf;
