// Suppress console output during tests
// Only show errors, not warnings or logs from the logger

const originalWarn = console.warn;
const originalLog = console.log;
const originalInfo = console.info;

global.console = {
  ...console,
  // Keep error output
  error: console.error,
  
  // Suppress warnings unless they're NOT from our logger
  warn: (...args) => {
    const message = args[0];
    if (typeof message === 'string' && !message.includes('[WARN]')) {
      originalWarn(...args);
    }
  },
  
  // Suppress info logs from logger
  log: (...args) => {
    const message = args[0];
    if (typeof message === 'string' && !message.includes('[INFO]')) {
      originalLog(...args);
    }
  },
  
  // Suppress info
  info: (...args) => {
    const message = args[0];
    if (typeof message === 'string' && !message.includes('[INFO]')) {
      originalInfo(...args);
    }
  }
};
