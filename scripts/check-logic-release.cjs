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

async function main() {
  const plan = await getReleasePlan(require('./logic-package.json'));
  const message = plan.publish
    ? `Will publish ${plan.name}@${plan.version} after verification.`
    : `${plan.name}@${plan.version} already exists; verify only, skip publishing.`;
  console.log(message);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${plan.version}\npublish=${plan.publish}\n`
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  }
}

module.exports = { getReleasePlan };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
