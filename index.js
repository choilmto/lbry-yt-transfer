const logger = require('winston');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));
const YoutubeDownload = require('./lib/YoutubeDownload');
const LbryUpload = require('./lib/LbryUpload');
const BerkeleySync = require('./lib/BerkeleySync');
const lbry = require('lbry-nodejs');
const Config = require('./lib/config');

/* ---LOGGING--- */
const now = new Date();
const t = now.toISOString().replace(/[:.]/gi, '-');
const fname = './log/' + t + '.log';
try {
  fs.mkdirSync('./log');
}
catch (e) {
}

logger.level = 'debug';

logger.remove(
  logger.transports.Console
).add(logger.transports.Console, {
  colorize: true,
  handleExceptions: true,
  humanReadableUnhandledException: true
}).add(logger.transports.File, {
  level: 'debug',
  filename: fname,
  handleExceptions: true
}).handleExceptions(new logger.transports.File({
  filename: './crash.log'
}));

//TODO: deprecate this
if (argv.hasOwnProperty('berkeleySync')) {
  const berkeleySync = new BerkeleySync();
}
else {
  //UCiGpQ84lgDBJUQaU16nUHqg
  //require a channel id to sync
  if (!argv.hasOwnProperty('channelid')) {
    console.error('channelid unspecified. --channelid=youtubeChannelID')
    return 1;
  }

  //require a tag for the claims
  if (!argv.hasOwnProperty('tag') || argv.tag.search(/[^A-Za-z0-9\-]/g) !== -1) {
    console.error('invalid custom tag. --tag=SomethingValid (a-Z, numbers and dashes)')
    return 1;
  }

  //account for user limits
  let userLimit = -1;
  if (argv.hasOwnProperty('limit')) {
    if (argv.limit.search(/[^0-9]/g) !== -1) {
      console.error('invalid limit. --limit=value')
      return 1;
    }

    userLimit = argv.limit;
  }

  lbry.status().then(daemonStatus => {
    if (daemonStatus.hasOwnProperty('result') && daemonStatus.result.is_running === true) {
      //initialize the downloader
      const youtubeDownload = new YoutubeDownload(Config());
      youtubeDownload.setLimit(userLimit);
      //sync function for the channel
      let syncToLBRY = new function (channelID) {
        return new Promise(function (fulfill, reject) {
          logger.info('Uploading to LBRY... Please wait');
          //initialize the uploader
          const lbryUpload = new LbryUpload(argv.channelid, argv.tag, userLimit, "/mnt/bigdrive/videos/");
          if (argv.hasOwnProperty('lbrychannel')) {
            //if a channel is specified then check whethere or not we own it
            lbryUpload.setChannel(argv.lbrychannel)
              //take care of the case where we don't own the channel
              .catch((error) => {
                if (argv.hasOwnProperty('claimchannel')) {
                  //the user specified to claim the channel if it isn't existing
                  //therefore we claim one for 1LBC
                  lbry.channel_new(argv.lbrychannel, 1);
                  //We should technically wait for 1 block at this time otherwise the script will try to claim the channel again if restarted...
                }
                else {
                  logger.error("[YT-LBRY] the specified channel is not owned. Use --claimchannel");
                  throw new Error("the specified channel is not owned. Use --claimchannel");
                }
              })
              //if we own it then proceed with the upload
              .then(lbryUpload.performSyncronization)
              .catch(reject)              
              .then(fulfill);
          }
          else {
            //if no channel is specified just proceed with the upload
            return lbryUpload.performSyncronization();
          }
        });
      }
      //download the videos in the channel
      youtubeDownload.resolveChannelPlaylist(argv.channelid)
        //.then(console.log)
        //upload the videos to lbry
        .then(syncToLBRY)
        .then(o => { logger.info('[YT-LBRY] Done syncing to LBRY!'); })
        .catch(console.error);

    }
    else {
      reject("[YT-LBRY] The daemon is not running!");
    }
  });
}