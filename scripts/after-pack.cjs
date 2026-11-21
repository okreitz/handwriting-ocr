// electron-builder hook. The app is not signed with an Apple developer
// certificate, which leaves the macOS bundle with a broken signature, and
// Apple Silicon Macs then refuse a downloaded copy as "damaged". An ad-hoc
// signature seals the bundle so it can be opened via "Open Anyway".
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appPath = join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
    stdio: "inherit",
  });
};
