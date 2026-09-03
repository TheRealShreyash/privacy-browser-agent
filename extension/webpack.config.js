// webpack.config.js
const path = require("path");
const CopyWebpackPlugin = require("copy-webpack-plugin");

const SRC = path.resolve(__dirname, "src");
const DIST = path.resolve(__dirname, "dist");

// ---------------------------------------------------------------------------
// Shared base configuration
// ---------------------------------------------------------------------------
const baseConfig = {
  resolve: {
    extensions: [".ts", ".js"],
    // Transformers.js needs these fallbacks in non-Node environments
    fallback: {
      fs: false,
      path: false,
      crypto: false,
      buffer: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  // Don't bundle node_modules (only matters for content/popup targets)
  externals: {},
};

// ---------------------------------------------------------------------------
// Background service worker  (must be a single file — no importScripts)
// ---------------------------------------------------------------------------
const backgroundConfig = {
  ...baseConfig,
  name: "background",
  entry: path.join(SRC, "background.ts"),
  target: "webworker",
  output: {
    filename: "background.js",
    path: DIST,
    // Important: no code-splitting for service workers
    chunkFilename: "[name].chunk.js",
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        // Copy ONNX Runtime WASM binaries (needed for Transformers.js WASM fallback)
        {
          from: path.resolve(
            __dirname,
            "node_modules/onnxruntime-web/dist/*.wasm"
          ),
          to: path.join(DIST, "wasm/[name][ext]"),
          noErrorOnMissing: true,
        },
        {
          from: path.resolve(
            __dirname,
            "node_modules/onnxruntime-web/dist/*.mjs"
          ),
          to: path.join(DIST, "wasm/[name][ext]"),
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
  optimization: {
    // Keep background as a single chunk — MV3 service workers can't use dynamic imports
    splitChunks: false,
    runtimeChunk: false,
  },
};

// ---------------------------------------------------------------------------
// Content script  (runs in page context, has access to DOM)
// ---------------------------------------------------------------------------
const contentConfig = {
  ...baseConfig,
  name: "content",
  entry: path.join(SRC, "content.ts"),
  target: "web",
  output: {
    filename: "content.js",
    path: DIST,
  },
  optimization: {
    splitChunks: false,
    runtimeChunk: false,
  },
};

// ---------------------------------------------------------------------------
// Popup script  (standard browser action popup)
// ---------------------------------------------------------------------------
const popupConfig = {
  ...baseConfig,
  name: "popup",
  entry: path.join(SRC, "popup.ts"),
  target: "web",
  output: {
    filename: "popup.js",
    path: DIST,
  },
  optimization: {
    splitChunks: false,
    runtimeChunk: false,
  },
};

module.exports = [backgroundConfig, contentConfig, popupConfig];
