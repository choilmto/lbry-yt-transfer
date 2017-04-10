'use strict';
const logger = require('winston');
const request = require("request");
const sqlite3 = require('sqlite3');
var s3 = require('s3');
const fs = require('fs');
const db = new sqlite3.Database('db.sqlite');
let _channelID;
let _customTag;
let _videosLocation;

class LbryUpload {
  constructor(channelID, customTag, limit, videosLocation) {
    _channelID = channelID;
    _customTag = customTag;
    _videosLocation = videosLocation;
    db.run("CREATE TABLE IF NOT EXISTS syncd_videos (videoid TEXT UNIQUE, claimname TEXT)");
    //this.performSyncronization();
  }
}

LbryUpload.prototype.performSyncronization = function () {
  checkDaemon()
    .then(getAllUnprocessedVideos)
    .then(data => {
      data.forEach(row => {
        setupPayload(row)
          .then(publish)
          .then(savePublish)
          .catch(logger.error);
      });
    }).catch(logger.error);
};

/**
 * Call this function to verify if the daemon is up and responding
 */
function checkDaemon() {
  return new Promise(function (fulfill, reject) {
    var options = {
      method: 'POST',
      url: 'http://localhost:5279/lbryapi',
      body: '{"method":"status" }'
    };

    request(options, function (error, response, body) {
      if (error) {
        reject(error);
      }
      else if (JSON.parse(body)['result'].hasOwnProperty('is_running') && JSON.parse(body)['result'].is_running === true) {
        logger.info(body);
        fulfill(body);
      }
      else {
        reject(body);
      }
    });
  });
}

function getAllUnprocessedVideos() {
  //TODO: parametrize this
  //maximum amount of videos sync'd to LBRY in one run
  const limit = 10;
  return new Promise(function (fulfill, reject) {
    //sync'd videos are not sync'd anymore, so every time the script is called it will upload $limit new videos
    const query =
      "SELECT videoid,channelid,fulltitle,description, thumbnail, data " +
      "FROM videos WHERE downloaded = 1 " +
      "AND videos.videoid NOT IN (select videoid FROM syncd_videos) " +
      "LIMIT " + limit + ";"

    db.all(query,
      function (err, rows) {
        if (err) {
          reject(err);
        }
        else {
          fulfill(rows);
        }
      });
  });
}


function setupPayload(row) {
  const filename = row.videoid + ".mp4";
  let name = _customTag + "-" + row.videoid.replace(/[^A-Za-z0-9\-]/g, '-');
  let filePath = _videosLocation + row.channelid + '/' + filename;
  return new Promise(function (fulfill, reject) {

    const payload = {
      method: "publish",
      params: {
        //claim names only allow chars and numbers and dashes
        name: name,
        file_path: filePath,
        bid: 1.0,
        metadata: {
          author: JSON.parse(row.data).channelTitle,
          description: row.description,
          language: "en",
          license: "",
          nsfw: false,
          thumbnail: "http://berk.ninja/thumbnails/" + row.videoid,
          title: row.fulltitle
        },
        sources: {
          contentType: "video/mp4"
        }
        /* it's not required to specify a fee at all if we want it to be 0
         I will include it anyway for future reference */
        /*fee: {
         LBC: {
         amount: 0.0
         }
         }*/
      }
    }
    fulfill({ payload: payload, filename: filename, videodata: row });
  });
};


/**
 * download a given ucberkeley video to local storage
 * @param {String} s3Path
 * @param {String} filename
 * @param {Object} payload
 */

/**
 * publish to lbry
 * @param {Object} payloadBundle
 */
function publish(payloadBundle) {
  logger.info(JSON.stringify(payloadBundle));
  return new Promise(function (fulfill, reject) {
    const options = {
      method: 'POST',
      url: 'http://localhost:5279/lbryapi',
      body: JSON.stringify(payloadBundle.payload)
    };

    request(options, (error, response, body) => {
      if (error) {
        reject(error);
      }
      else if (response.statusCode !== 200 || JSON.parse(body).hasOwnProperty('error')) {
        reject(body);
      }
      else {
        fulfill({ claimname: payloadBundle.payload.params.name, videodata: payloadBundle.videodata });
      }
    });

  });
}


function savePublish(publishResponse) {
  const filename = _videosLocation + _channelID + '/' + publishResponse.videodata.videoid + ".mp4"
  logger.info('Published ' + filename + " to " + publishResponse.claimname);
  db.serialize(function () {
    const stmt = db.prepare("INSERT OR IGNORE INTO syncd_videos VALUES (?,?);");
    stmt.run(publishResponse.videodata.videoid, publishResponse.claimname);
    stmt.finalize();
  });
  fs.unlink(filename, err => {
    logger.info(err ? ("unlink failed: " + err) : ("file deleted: " + filename))
  });
}

module.exports = LbryUpload;