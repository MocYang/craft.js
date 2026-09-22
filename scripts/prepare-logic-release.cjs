const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const releaseRoot = path.join(root, 'release');
const stagingDir = path.join(releaseRoot, 'logic-craftjs');
const metadata = require('./logic-package.json');

function runTool(tool, args, cwd, env = {}) {
  const result = spawnSync(process.execPath, [require.resolve(tool), ...args], {
    cwd,
    env: { ...process.env, NODE_ENV: 'production', ...env },
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${tool} failed in ${path.relative(root, cwd)}`);
  }
}

try {
  for (const name of ['utils', 'core']) {
    const cwd = path.join(root, 'packages', name);
    runTool(
      'typescript/bin/tsc',
      ['--skipLibCheck', '--emitDeclarationOnly'],
      cwd
    );
    runTool(
      'rollup/dist/bin/rollup',
      ['-c', 'rollup.config.js'],
      cwd,
      name === 'core'
        ? {
            CRAFTJS_PACKAGE_NAME: metadata.name,
            CRAFTJS_PACKAGE_VERSION: metadata.version,
          }
        : {}
    );
  }

  // Restrict cleanup to the generated staging directory inside this checkout.
  if (path.dirname(stagingDir) !== releaseRoot) {
    throw new Error('Invalid release staging directory');
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const coreDir = path.join(root, 'packages', 'core');
  const manifest = {
    ...require(path.join(coreDir, 'package.json')),
    ...metadata,
  };
  delete manifest.scripts;
  delete manifest.devDependencies;

  for (const folder of ['dist', 'lib']) {
    fs.cpSync(path.join(coreDir, folder), path.join(stagingDir, folder), {
      recursive: true,
      filter: (source) => !source.endsWith('.tsbuildinfo'),
    });
  }
  fs.copyFileSync(
    path.join(coreDir, 'LICENSE'),
    path.join(stagingDir, 'LICENSE')
  );
  fs.copyFileSync(
    path.join(__dirname, 'logic-package.README.md'),
    path.join(stagingDir, 'README.md')
  );
  fs.writeFileSync(
    path.join(stagingDir, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  console.log(`Prepared ${metadata.name}@${metadata.version} in ${stagingDir}`);
} catch (error) {
  console.error(`Release preparation failed: ${error.message}`);
  process.exitCode = 1;
}
