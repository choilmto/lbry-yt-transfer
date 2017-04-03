const logger = require('winston');
const fs = require('fs');
const LbryTrnsf = require('./lib/LbryTrnsf');
const LbryUpload = require('./lib/LbryUpload');

const Config = require('./lib/config');

/* ---LOGGING--- */
const now = new Date();
const t = now.toISOString().replace(/[:.]/gi, '-');
const fname = './log/' + t + '.log';
try
{
  fs.mkdirSync('./log');
}
catch (e)
{
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

var param = process.argv[2];
const config = Config();
if (param !== undefined){
if(param.indexOf('--berkeley') !== -1){ //for development
  const lbryUpload = new LbryUpload();
}}else{
  const lbryTrnsf = new LbryTrnsf(config);
  lbryTrnsf.resolveChannelPlaylist('UCiGpQ84lgDBJUQaU16nUHqg').then(console.log).catch(console.error);
}
