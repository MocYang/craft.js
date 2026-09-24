const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'logic-package.json');
const source = fs.readFileSync(file, 'utf8');
const { version } = JSON.parse(source);
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

if (
  !match ||
  !Number.isSafeInteger(Number(match[3]) + 1) ||
  !source.includes(`"version": "${version}"`)
) {
  throw new Error('Expected a stable x.y.z version in logic-package.json');
}

const next = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
fs.writeFileSync(
  file,
  source.replace(`"version": "${version}"`, `"version": "${next}"`)
);
console.log(`${version} -> ${next}`);
