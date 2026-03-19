// Replaced at build time via sed
const RAW_VERSION = '__VERSION__'
export const VERSION = RAW_VERSION.startsWith('__') ? 'dev' : RAW_VERSION
