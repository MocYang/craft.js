const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const { createRequire } = require('module');
const os = require('os');
const path = require('path');

const { nodeResolve } = require('@rollup/plugin-node-resolve');
const { rollup } = require('rollup');

const metadata = require('./logic-package.json');

function runNode(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Command failed: node ${args.join(' ')}`);
}

async function verifyRuntime(core, consumerRequire) {
  const React = consumerRequire('react');
  const { createRoot } = consumerRequire('react-dom/client');
  const { act } = React;
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const denied = [];
  let store;
  function Harness() {
    store = core.useEditorStore(
      { editAccess: true, onEditDenied: (event) => denied.push(event) },
      () => {}
    );
    return null;
  }
  await act(() => root.render(React.createElement(Harness)));
  try {
    const nodes = {};
    for (const id of ['ROOT', 'child']) {
      nodes[id] = store.query
        .parseFreshNode({
          id,
          data: {
            type: 'div',
            isCanvas: true,
            parent: id === 'ROOT' ? null : 'ROOT',
            nodes: id === 'ROOT' ? ['child'] : [],
            props: { style: { width: 100, color: 'black' } },
            custom: { editorLock: id === 'child' ? 'position' : '' },
          },
        })
        .toNode();
    }
    await act(() => {
      store.actions.transact({ source: 'document-load' }, (actions) => {
        actions.replaceNodes(nodes);
      });
      store.actions.history.clear();
    });
    await act(() =>
      store.actions.setProp('child', (props) => {
        props.style.color = 'red';
      })
    );
    assert.equal(store.query.node('child').get().data.props.style.color, 'red');
    const before = store.query.serialize();
    const pointer = store.history.pointer;
    await act(() =>
      store.actions.setProp('child', (props) => {
        props.style.width = 200;
      })
    );
    assert.equal(
      store.query.serialize(),
      before,
      'Packaged utils must enforce validation'
    );
    assert.equal(
      store.history.pointer,
      pointer,
      'Rejected edits must not enter history'
    );
    assert.equal(denied.length, 1);
    await act(() =>
      store.actions.setState((state) => {
        state.nodes.child.data.props.style.width = 300;
      })
    );
    assert.equal(
      store.query.serialize(),
      before,
      'setState must use the same validator'
    );
    await act(() => store.actions.setEditorLock('child', ''));
    await act(() =>
      store.actions.setProp('child', (props) => {
        props.style.width = 200;
      })
    );
    assert.equal(store.query.node('child').get().data.props.style.width, 200);
    await act(() => store.actions.history.undo());
    assert.equal(store.query.node('child').get().data.props.style.width, 100);
    await act(() => store.actions.history.redo());
    assert.equal(store.query.node('child').get().data.props.style.width, 200);
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
}

async function verifyPackage(tarball, reactVersion) {
  assert.ok(
    tarball && fs.existsSync(tarball),
    'Pass the freshly packed .tgz path'
  );
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'craftjs-package-'));
  console.log(`Independent package consumer: ${consumer}`);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ private: true })
  );
  const npmCli = path.join(
    path.dirname(process.execPath),
    'node_modules/npm/bin/npm-cli.js'
  );
  assert.ok(fs.existsSync(npmCli), 'The Node installation must include npm');
  runNode(
    [
      npmCli,
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--registry=https://registry.npmjs.org/',
      path.resolve(tarball),
      `react@${reactVersion}`,
      `react-dom@${reactVersion}`,
      `@types/react@${reactVersion.split('.')[0]}`,
      `@types/react-dom@${reactVersion.split('.')[0]}`,
      '@types/lodash@4',
      'jsdom@26.1.0',
    ],
    consumer
  );
  const consumerRequire = createRequire(path.join(consumer, 'package.json'));
  const manifestPath = consumerRequire.resolve(`${metadata.name}/package.json`);
  const manifest = consumerRequire(manifestPath);
  const packageDir = path.dirname(manifestPath);
  assert.equal(manifest.name, metadata.name);
  assert.equal(manifest.version, metadata.version);
  assert.equal(manifest.dependencies['@craftjs/utils'], undefined);
  assert.throws(() => consumerRequire.resolve('@craftjs/utils'));
  assert.ok(fs.existsSync(path.join(packageDir, 'internal/utils/LICENSE')));
  for (const format of ['cjs', 'esm']) {
    const source = fs.readFileSync(
      path.join(packageDir, `dist/${format}/index.js`),
      'utf8'
    );
    assert.ok(source.includes(`../../internal/utils/dist/${format}/index.js`));
    for (const prefix of ['', 'internal/utils/']) {
      const map = JSON.parse(
        fs.readFileSync(
          path.join(packageDir, `${prefix}dist/${format}/index.js.map`),
          'utf8'
        )
      );
      assert.ok(
        map.sources.length && map.sourcesContent.length,
        'Source maps must retain embedded source'
      );
    }
  }

  const { JSDOM } = consumerRequire('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  global.window = dom.window;
  global.document = dom.window.document;
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: dom.window.navigator,
  });
  global.IS_REACT_ACT_ENVIRONMENT = true;
  await verifyRuntime(consumerRequire(metadata.name), consumerRequire);
  assert.equal(window.__CRAFTJS__[metadata.name], metadata.version);

  const input = path.join(consumer, 'esm-probe.mjs');
  fs.writeFileSync(input, `export * from '${metadata.name}';\n`);
  const external = [
    'react',
    'react-dom',
    ...Object.keys(manifest.dependencies),
  ];
  const bundle = await rollup({
    input,
    plugins: [nodeResolve({ mainFields: ['module', 'main'] })],
    external: (id) =>
      external.some((name) => id === name || id.startsWith(`${name}/`)),
  });
  const esmConsumer = path.join(consumer, 'esm-probe.cjs');
  try {
    await bundle.write({ file: esmConsumer, format: 'cjs' });
  } finally {
    await bundle.close();
  }
  await verifyRuntime(consumerRequire(esmConsumer), consumerRequire);
  dom.window.close();

  fs.writeFileSync(
    path.join(consumer, 'consumer.ts'),
    `
import { EditAccessPolicy, EditDenied, EditorStore, Options } from '${metadata.name}';
const policy: EditAccessPolicy = { isGeometryProp: (path) => path[0] === 'position' };
const options: Partial<Options> = { editAccess: policy, onEditDenied: (event: EditDenied) => { event.action.type; } };
declare const store: EditorStore;
store.actions.setEditorLock('child', 'position');
store.actions.transact({ source: 'user-edit' }, actions => actions.setProp('child', props => { props.label = 'updated'; }));
store.query.node('child').getEditAccess({ operation: 'geometry' }).allowed;
void options;
`
  );
  runNode(
    [
      require.resolve('typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      'false',
      '--target',
      'ES2020',
      '--module',
      'ESNext',
      '--moduleResolution',
      'node',
      '--esModuleInterop',
      '--lib',
      'ES2020,DOM',
      'consumer.ts',
    ],
    consumer
  );
  console.log(
    `Verified ${metadata.name}@${metadata.version} with React ${reactVersion}: isolated CJS, ESM, declarations, edit validation and history`
  );
}

verifyPackage(process.argv[2], process.argv[3] || '18.3.1').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
