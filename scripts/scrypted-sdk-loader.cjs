// Scrypted's Node plugin bundle uses CommonJS. The SDK also contains an
// optional ESM loading branch; disable it before parsing the SDK as CommonJS.
module.exports = function scryptedSdkCommonJs(source) {
  return source.replace(/\bimport\.meta\b/g, 'undefined');
};
