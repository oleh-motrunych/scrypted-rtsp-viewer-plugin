// Scrypted's Node plugin bundle uses CommonJS. SDK 0.5.59 also contains an
// optional ESM loading branch; disable it before parsing the SDK as CommonJS.
module.exports = function scryptedSdkCommonJs(source) {
  return source.replace(/\bimport\.meta\b/g, 'undefined');
};
