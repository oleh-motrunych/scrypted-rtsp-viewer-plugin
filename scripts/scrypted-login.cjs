const { target, tlsOptions, request, saveLogin } = require('./scrypted-api.cjs');
async function main() {
  if (process.argv.length !== 3) throw new Error('Usage: npm run scrypted-login -- HOST:PORT');
  const host = process.argv[2];
  tlsOptions(target(host));
  const readline = require('readline-sync');
  const username = readline.question('Scrypted username: ');
  const password = readline.question('Scrypted password: ', { hideEchoBack: true });
  const response = await request(host, '/login', { username, token: password });
  if (response.error || typeof response.token !== 'string' || !response.token) throw new Error('Scrypted login failed.');
  await saveLogin(host, { username: response.username || username, token: response.token });
  console.log('Scrypted login saved.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
