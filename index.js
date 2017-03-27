const logger = require('winston');
const fs = require('fs');
const LbryTrnsf = require('./lib/LbryTrnsf');
const LbryUpload = require('./lib/LbryUpload');

const Config = require('./lib/config');

/* ---LOGGING--- */
const now = new Date();
const t = now.toISOString().replace(/[:.]/gi, '-');
const fname = './log/' + t + '.log';
try {
	fs.mkdirSync('./log');
} catch (e) {}

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

const config = Config();

const lbryUpload = new LbryUpload();
//const lbryTrnsf = new LbryTrnsf(config);
