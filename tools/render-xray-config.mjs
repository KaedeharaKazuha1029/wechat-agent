import { readFile, writeFile } from 'node:fs/promises';

const [source, destination, selectedTag] = process.argv.slice(2);
if (!source || !destination) {
  console.error('Usage: node tools/render-xray-config.mjs <source-xray.json> <new-private-config.json> [outbound-tag]');
  process.exit(1);
}
try {
  const config = JSON.parse((await readFile(source, 'utf8')).replace(/^\uFEFF/, ''));
  const supported = new Set(['trojan', 'vless', 'vmess', 'shadowsocks', 'socks', 'http']);
  const candidates = (config.outbounds ?? []).filter(outbound => supported.has(outbound.protocol) && (!selectedTag || outbound.tag === selectedTag));
  if (candidates.length !== 1 || candidates[0].proxySettings?.tag || candidates[0].streamSettings?.sockopt?.dialerProxy) {
    throw Error('Select exactly one supported outbound without a chained proxy.');
  }
  const outboundTag = 'wechat-dot-upstream';
  const scoped = {
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'dot-only', listen: '/run/weixin-dot-xray/http.sock,0660', protocol: 'http', settings: { allowTransparent: false } }],
    outbounds: [{ tag: 'deny', protocol: 'blackhole' }, { ...candidates[0], tag: outboundTag }],
    routing: { domainStrategy: 'AsIs', rules: [{ type: 'field', inboundTag: ['dot-only'], domain: ['full:connectors.api.openai.com'], port: '443', network: 'tcp', outboundTag }] },
  };
  await writeFile(destination, JSON.stringify(scoped, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Wrote a private Dot-only configuration. Keep that file outside Git.');
} catch (error) {
  if (error.code) console.error(`Cannot write the private Xray configuration (${error.code}).`);
  else if (!(error instanceof SyntaxError)) console.error(error.message);
  else console.error('The source is not valid Xray JSON.');
  process.exitCode = 1;
}
