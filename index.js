const logger = require('winston');
const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));
const LbryTrnsf = require('./lib/LbryTrnsf');
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

if (argv.hasOwnProperty('berkeleySync')) {
  const berkeleySync = new BerkeleySync();
}
else {
  //UCiGpQ84lgDBJUQaU16nUHqg
  if (!argv.hasOwnProperty('channelid')) {
    console.error('channelid unspecified. --channelid=youtubeChannelID')
    return 1;
  }

  if (!argv.hasOwnProperty('tag') || argv.tag.search(/[^A-Za-z0-9\-]/g) !== -1) {
    console.error('invalid custom tag. --tag=SomethingValid (a-Z, numbers and dashes)')
    return 1;
  }

  const config = Config();
  const lbryTrnsf = new LbryTrnsf(config);
  lbryTrnsf.resolveChannelPlaylist(argv.channelid)
    .then(channelID => {
      console.log('syncing to LBRY... Please wait');
      const lbryUpload = new LbryUpload(channelID, argv.tag, 10, "/mnt/bigdrive/videos/");
      if (argv.hasOwnProperty('lbrychannel'))
        lbryUpload.setChannel(argv.lbrychannel).then(result => {
          if (result.owned === true)
            lbryUpload.performSyncronization();
          else
            console.error('the specified channel is not currently owned');
        }).catch(console.error);
      else
        lbryUpload.performSyncronization();
    })
    .then(o => { console.log('Done syncing to LBRY!'); })
    .catch(console.error);
}