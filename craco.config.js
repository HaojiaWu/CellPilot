module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      webpackConfig.resolve.mainFields = ['module', 'browser', 'main'];

      webpackConfig.output.publicPath = 'auto';

      webpackConfig.resolve.fallback = {
        ...webpackConfig.resolve.fallback,
        fs: false,
        path: false,
      };

      webpackConfig.output.globalObject = 'self';

      webpackConfig.optimization.splitChunks = {
        cacheGroups: {
          default: false,
          defaultVendors: false,
        },
      };

      webpackConfig.optimization.runtimeChunk = false;

      webpackConfig.ignoreWarnings = [
        ...(webpackConfig.ignoreWarnings || []),
        { module: /[\\/]node_modules[\\/]igv[\\/]/ },
        { module: /[\\/]node_modules[\\/]@mlc-ai[\\/]web-llm[\\/]/ },
      ];

      return webpackConfig;
    },
  },
};
