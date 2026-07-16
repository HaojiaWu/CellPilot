const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!keychainProfile) {
    throw new Error('APPLE_KEYCHAIN_PROFILE environment variable is not set. Please set it to your notarization keychain profile name.');
  }


  await notarize({
    tool: 'notarytool',
    appPath,
    keychainProfile,
  });

};
