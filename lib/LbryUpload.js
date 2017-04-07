'use strict';
const request = require("request");
const sqlite3 = require('sqlite3');
var s3 = require('s3');
const fs = require('fs');
const db = new sqlite3.Database('db.sqlite');

class LbryUpload {
  constructor(channelID, customTag, limit) {
    this.channelID = channelID;
    this.customTag = customTag;
    db.run("CREATE TABLE IF NOT EXISTS syncd_videos (videoid TEXT UNIQUE, claimname TEXT)");
    this.performSyncronization();
  }
}

LbryUpload.prototype.performSyncronization = function() {
  ensureDaemon()
    .then(getAllUnprocessedVideos)
    .then(data => {
      data.forEach(row => {
        setupPayload(row)
          .then(downloadVideo)
          .then(publish)
          .then(savePublish)
          .catch(console.error);
      });
    }).catch(console.error);
};

/**
 * Call this function to verify if the daemon is up and responding
 */
function ensureDaemon() {
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
        console.log(body);
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
      "FROM videos WHERE downloaded = 1' " +
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


LbryUpload.prototype.setupPayload = function(row) {
  return new Promise(function (fulfill, reject) {
    const filename = row.videoid + ".mp4";
    const payload = {
      method: "publish",
      params: {
        //claim names only allow chars and numbers and dashes
        name: this.customTag + "-" + row.videoid.replace(/[^A-Za-z0-9\-]/g, '-'),
        file_path: "/mnt/bigdrive/temp/" + filename,
        bid: 1.0,
        metadata: {
          author: row.data.channelTitle,
          content_type: "video/mp4",
          description: row.description,
          language: "en",
          license: "",
          nsfw: false,
          thumbnail: "http://berk.ninja/thumbnails/" + row.videoid,
          title: row.fulltitle
        },
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
}


/**
 * download a given ucberkeley video to local storage
 * @param {String} s3Path
 * @param {String} filename
 * @param {Object} payload
 */
function downloadVideo(payloadBundle) {
  const s3Path = 'videos/' + payloadBundle.videodata.channelid + '/' + payloadBundle.filename;
  const filename = "/mnt/bigdrive/temp/" + payloadBundle.filename;

  return new Promise(function (fulfill, reject) {
    const client = s3.createClient({
      maxAsyncS3: 20,     // this is the default
      s3RetryCount: 3,    // this is the default
      s3RetryDelay: 1000, // this is the default
      multipartUploadThreshold: 20971520, // this is the default (20 MB)
      multipartUploadSize: 15728640, // this is the default (15 MB)
      s3Options: {
        accessKeyId: process.env.s3_access_key,
        secretAccessKey: process.env.s3_secret_key,
        region: "us-east-2",
      },
    });

    const params = {
      localFile: filename,
      s3Params: {
        Bucket: "lbry-niko2",
        Key: s3Path,
      },
    };

    const downloader = client.downloadFile(params);
    downloader.on('error', function (err) {
      reject(err);
    });
    downloader.on('end', function () {
      console.log("done downloading " + filename);
      fulfill({ payload: payloadBundle.payload, filename: filename, videodata: payloadBundle.videodata });
    });
  });
}


/**
 * publish to lbry
 * @param {Object} payload
 * @param {String} filename
 * @param {Object} videodata
 */
function publish(payloadBundle) {
  console.log(JSON.stringify(payloadBundle));
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
  const filename = "/mnt/bigdrive/temp/" + publishResponse.videodata.videoid + ".mp4"
  console.log('Published ' + filename + " to " + publishResponse.claimname);
  db.serialize(function () {
    const stmt = db.prepare("INSERT OR IGNORE INTO syncd_videos VALUES (?,?);");
    stmt.run(publishResponse.videodata.videoid, publishResponse.claimname);
    stmt.finalize();
  });
  fs.unlink(filename, err => {
    console.log(err ? ("unlink failed: " + err) : ("file deleted: " + filename))
  });
}

module.exports = LbryUpload;