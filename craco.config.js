module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      // Prefer ESM over UMD for igv so dynamic import gets default export with createBrowser
      webpackConfig.resolve.mainFields = ['module', 'browser', 'main'];

      // Fix: CRA sets publicPath to "./" (from homepage: "./") which breaks Web Worker
      // chunk loading in the packaged Electron app. Workers load dependency chunks via
      // importScripts(), and a relative "./" resolves against the WORKER SCRIPT'S location
      // (build/static/js/), not the document root (build/), giving a wrong double path:
      //   "./static/js/673.chunk.js" from "build/static/js/" → "build/static/js/static/js/..."
      // "auto" makes webpack compute the base URL from the current script's location at
      // runtime, which works correctly in both the main thread and worker contexts.
      webpackConfig.output.publicPath = 'auto';

      // Emscripten svd_core.js has require('fs')/require('path') in a Node-only branch; browser never runs it
      webpackConfig.resolve.fallback = {
        ...webpackConfig.resolve.fallback,
        fs: false,
        path: false,
      };

      // Fix for ES module workers by disabling ALL code splitting
      // This creates larger bundles but avoids importScripts() issues completely
      webpackConfig.output.globalObject = 'self';

      // Completely disable code splitting
      webpackConfig.optimization.splitChunks = {
        cacheGroups: {
          default: false,
          defaultVendors: false,
        },
      };

      // Disable runtime chunk
      webpackConfig.optimization.runtimeChunk = false;

      // Ignore missing source map from igv (circular-view.css.map not shipped in package)
      webpackConfig.ignoreWarnings = [
        ...(webpackConfig.ignoreWarnings || []),
        { module: /[\\/]node_modules[\\/]igv[\\/]/ },
        { module: /[\\/]node_modules[\\/]@mlc-ai[\\/]web-llm[\\/]/ },
      ];

      return webpackConfig;
    },
  },
};
