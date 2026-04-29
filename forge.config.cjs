// forge.config.cjs
// Electron Forge configuration for building installers on Windows

const { MakerZIP } = require('@electron-forge/maker-zip');
// const { MakerWix } = require('@electron-forge/maker-wix');

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    asar: true, // bundle source into an asar archive
  },
  rebuildConfig: {},
  makers: [
    // Simple ZIP output (good for quick sharing or debugging)
    new MakerZIP({
      platforms: ['win32'],
    }),

    // Proper Windows installer (.msi) via WiX — disabled for now
    /*
    new MakerWix({
      languages: ['en-US'],
      manufacturer: 'Gener8',
      description: 'Smart Cartridge Build Tracker',
      programName: 'Smart Cartridge Build Tracker',
      // icon: 'assets/icon.ico', // set this once you have an .ico
    }),
    */
  ],
};
