import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const [publicOrigin, destination = join(project, '.runtime', 'plugins')] = process.argv.slice(2);
let origin;
try { origin = new URL(publicOrigin); } catch { console.error('Usage: npm run plugin:configure -- https://bridge.example.com [output-directory]'); process.exit(1); }
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  console.error('Provide only the public HTTPS origin, without a path, credentials, query, or fragment.');
  process.exit(1);
}

for (const alias of ['dot', 'chat']) {
  const source = join(project, 'plugins', alias);
  const target = resolve(destination, alias);
  if (target === resolve(source)) throw Error('Choose a separate output directory for deployment-specific plugin files.');
  const template = JSON.parse(await readFile(join(source, 'mcp.json'), 'utf8'));
  template.mcpServers[`wechat-${alias}`].url = `${origin.origin}/mcp/${alias}`;
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'plugin.json'), await readFile(join(source, 'plugin.json')));
  await writeFile(join(target, 'mcp.json'), JSON.stringify(template, null, 2) + '\n');
}
console.log(`Generated Dot and Chat/Work plugin manifests in ${resolve(destination)}.`);
