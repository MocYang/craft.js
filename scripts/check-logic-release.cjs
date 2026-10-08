const fs = require('fs');

async function getReleasePlan(metadata, fetchVersion = fetch) {
  const { name, version } = metadata;
  if (name !== '@deepctrls/craftjs' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      'Expected @deepctrls/craftjs with a stable x.y.z release version'
    );
  }
  const response = await fetchVersion(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`
  );
  // Only a genuine missing version permits publishing. Network/auth errors fail closed.
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(
      `Cannot determine npm release status: HTTP ${response.status}`
    );
  }
  return { name, version, publish: response.status === 404 };
}

function resolveMetadata(metadata, mode, version) {
  if (mode === 'stage') {
    if (!version) throw new Error('Stage mode requires a test version.');
    return { ...metadata, version };
  }
  if (mode !== 'publish' || version) {
    throw new Error(
      'A release version override is allowed only in stage mode.'
    );
  }
  return metadata;
}

async function main() {
  const mode = process.env.RELEASE_MODE || 'publish';
  const metadata = resolveMetadata(
    require('./logic-package.json'),
    mode,
    process.env.RELEASE_VERSION
  );
  const plan = await getReleasePlan(metadata);
  if (mode === 'stage' && !plan.publish) {
    throw new Error(
      `${plan.name}@${plan.version} already exists; choose an unpublished stage-test version.`
    );
  }
  const message =
    mode === 'stage'
      ? `Will stage ${plan.name}@${plan.version} after verification; it will not be published publicly.`
      : plan.publish
      ? `Will publish ${plan.name}@${plan.version} after verification.`
      : `${plan.name}@${plan.version} already exists; verify only, skip publishing.`;
  console.log(message);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${plan.version}\npublish=${plan.publish}\nmode=${mode}\n`
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}

module.exports = { getReleasePlan, resolveMetadata };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
