// Back-compat shim: all storage now goes through the provider-neutral helper (R2 or S3).
module.exports = require('./storage');
