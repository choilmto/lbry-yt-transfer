const logger = require('winston');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));
const YoutubeDownload = require('./lib/YoutubeDownload');
const LbryUpload = require('./lib/LbryUpload');
const BerkeleySync = require('./lib/BerkeleySync');

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

  //initialize the downloader
  const youtubeDownload = new YoutubeDownload(Config());

  //sync function for the channel
  let syncToLBRY = new function (channelID) {
    logger.info('Uploading to LBRY... Please wait');
    //initialize the uploader
    const lbryUpload = new LbryUpload(argv.channelid, argv.tag, 10, "/mnt/bigdrive/videos/");
    if (argv.hasOwnProperty('lbrychannel')) {
      //if a channel is specified then check whethere or not we own it
      lbryUpload.setChannel(argv.lbrychannel)
        //if we own it then proceed with the upload
        .then(lbryUpload.performSyncronization)
        //otherwise don't
        //TODO: perhaps create the channel if at this point it's not owned?
        .catch(console.error);
    }
    else {
      //if no channel is specified just proceed with the upload
      lbryUpload.performSyncronization();
    }
  }
  //download the videos in the channel
  youtubeDownload.resolveChannelPlaylist(argv.channelid)
    //upload the videos to lbry
    .then(syncToLBRY)
    .then(o => { console.log('Done syncing to LBRY!'); })
    .catch(console.error);
}