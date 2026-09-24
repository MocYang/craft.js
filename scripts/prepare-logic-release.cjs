const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { rollup } = require('rollup');
const loadConfigFile = require('rollup/dist/loadConfigFile');

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

async function buildCore(cwd, destination) {
  const previousCwd = process.cwd();
  const environment = {
    NODE_ENV: 'production',
    CRAFTJS_PACKAGE_NAME: metadata.name,
    CRAFTJS_PACKAGE_VERSION: metadata.version,
  };
  const previousEnvironment = {};
  for (const [key, value] of Object.entries(environment)) {
    previousEnvironment[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    process.chdir(cwd);
    const { options, warnings } = await loadConfigFile(
      path.join(cwd, 'rollup.config.js')
    );
    warnings.flush();
    for (const config of options) {
      const bundle = await rollup(config);
      try {
        for (const output of config.output) {
          // Keep the workspace build usable with its ordinary utility package.
          await bundle.write(output);
          await bundle.write({
            ...output,
            file: path.join(destination, 'dist', output.format, 'index.js'),
            paths: {
              '@craftjs/utils': `../../internal/utils/dist/${output.format}/index.js`,
            },
          });
        }
      } finally {
        await bundle.close();
      }
    }
  } finally {
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function copyBuild(source, destination, folders = ['dist', 'lib']) {
  for (const folder of folders) {
    fs.cpSync(path.join(source, folder), path.join(destination, folder), {
      recursive: true,
      filter: (file) => !file.endsWith('.tsbuildinfo'),
    });
  }
  fs.copyFileSync(
    path.join(source, 'LICENSE'),
    path.join(destination, 'LICENSE')
  );
}

function rewriteUtilityDeclarations(directory, utilityEntry) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteUtilityDeclarations(file, utilityEntry);
    } else if (entry.name.endsWith('.d.ts')) {
      let relative = path
        .relative(path.dirname(file), utilityEntry)
        .split(path.sep)
        .join('/');
      if (!relative.startsWith('.')) relative = `./${relative}`;
      const declaration = fs
        .readFileSync(file, 'utf8')
        .replace(
          /(['"])@craftjs\/utils\1/g,
          (_, quote) => `${quote}${relative}${quote}`
        );
      if (/(['"])@craftjs\/utils(?:\/|\1)/.test(declaration)) {
        throw new Error(`Unmapped utility declaration import: ${file}`);
      }
      fs.writeFileSync(file, declaration);
    }
  }
}

async function prepareRelease() {
  for (const name of ['utils', 'core']) {
    const cwd = path.join(root, 'packages', name);
    runTool(
      'typescript/bin/tsc',
      ['--skipLibCheck', '--emitDeclarationOnly', '--incremental', 'false'],
      cwd
    );
    if (name === 'utils') {
      runTool('rollup/dist/bin/rollup', ['-c', 'rollup.config.js'], cwd);
    }
  }

  // Restrict cleanup to the generated staging directory inside this checkout.
  if (path.dirname(stagingDir) !== releaseRoot) {
    throw new Error('Invalid release staging directory');
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  const coreDir = path.join(root, 'packages', 'core');
  const utilsDir = path.join(root, 'packages', 'utils');
  const utilsManifest = require(path.join(utilsDir, 'package.json'));
  const manifest = {
    ...require(path.join(coreDir, 'package.json')),
    ...metadata,
  };
  delete manifest.scripts;
  delete manifest.devDependencies;
  manifest.dependencies = {
    ...utilsManifest.dependencies,
    ...manifest.dependencies,
  };
  delete manifest.dependencies['@craftjs/utils'];
  manifest.files = [...manifest.files, 'internal'];

  copyBuild(coreDir, stagingDir, ['lib']);
  const vendoredUtils = path.join(stagingDir, 'internal', 'utils');
  copyBuild(utilsDir, vendoredUtils);
  await buildCore(coreDir, stagingDir);
  rewriteUtilityDeclarations(
    path.join(stagingDir, 'lib'),
    path.join(vendoredUtils, 'lib', 'index')
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
}

prepareRelease().catch((error) => {
  console.error(`Release preparation failed: ${error.message}`);
  process.exitCode = 1;
});
