const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const levelName = process.env.LOG_LEVEL || 'info';
const currentLevel = levels[levelName] ?? levels.info;

function ts() {
  return new Date().toISOString();
}

function fmt(level, msg, meta) {
  const base = `[${ts()}] ${level.toUpperCase()} ${msg}`;
  if (meta && typeof meta === 'object') {
    try {
      return `${base} ${JSON.stringify(meta)}`;
    } catch {
      return base;
    }
  }
  return base;
}

const logger = {
  level: levelName,
  error(msg, meta) {
    if (currentLevel >= levels.error) console.error(fmt('error', msg, meta));
  },
  warn(msg, meta) {
    if (currentLevel >= levels.warn) console.warn(fmt('warn', msg, meta));
  },
  info(msg, meta) {
    if (currentLevel >= levels.info) console.log(fmt('info', msg, meta));
  },
  debug(msg, meta) {
    if (currentLevel >= levels.debug) console.log(fmt('debug', msg, meta));
  }
};

export default logger;