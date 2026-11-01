const { deploy } = require('./scrypted-api.cjs');
if (process.argv.length !== 3) {
  console.error('Usage: npm run scrypted-deploy -- HOST:PORT');
  process.exit(1);
}
deploy(process.argv[2]).then(() => console.log('RTSP Live Viewer deployed.')).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
