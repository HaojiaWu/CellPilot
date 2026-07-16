/**
 * OpenSeadragon WebGL Overlay
 *
 * Renders WebGL content (scatter plots) directly on the OpenSeadragon canvas
 * by hooking into OSD's rendering pipeline. This ensures perfect coordinate
 * alignment between the image and overlaid content.
 *
 * Inspired by openSeadragonGL but adapted for overlay rendering instead of tile processing.
 */

import OpenSeadragon from 'openseadragon';

export class OSDWebGLOverlay {
  constructor(viewer, options = {}) {
    this.viewer = viewer;
    this.options = options;
    this.gl = null;
    this.program = null;
    this.buffers = {};
    this.isInitialized = false;
    this.isEnabled = true;
    this.renderCallback = null;

    this.pointData = null;
    this.pointsNeedUpdate = false;

    // Note: scaleFactor is unused, coordinate scaling is handled in SpatialPlotView.jsx
    this.transformMatrix = null;
    this.scaleFactor = 1.0;
  }

  /**
   * Initialize the WebGL overlay system
   */
  async init() {
    if (this.isInitialized) return;

    // Wait for OpenSeadragon to be ready
    await this._waitForViewer();

    // Get the canvas that OpenSeadragon uses
    const osdCanvas = this.viewer.drawer.canvas;

    // Create an overlay canvas positioned exactly on top
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.pointerEvents = 'none'; // Let OSD handle all interaction

    // Insert overlay canvas right after OSD canvas
    osdCanvas.parentNode.insertBefore(this.canvas, osdCanvas.nextSibling);

    // Match canvas size
    this._resizeCanvas();

    // Initialize WebGL context
    this.gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      antialias: false,
      powerPreference: 'high-performance',
    });

    if (!this.gl) {
      throw new Error('WebGL2 not supported');
    }

    // Compile shaders and create program
    await this._initShaders();

    // Create buffers
    this._initBuffers();

    // Hook into OpenSeadragon's animation loop
    this.viewer.addHandler('animation', this._onViewerUpdate.bind(this));
    this.viewer.addHandler('resize', this._onViewerResize.bind(this));
    // Re-render when image opens (important for custom tile sources)
    this.viewer.addHandler('open', this._onViewerOpen.bind(this));

    this.isInitialized = true;
  }

  /**
   * Wait for OpenSeadragon viewer to be fully ready
   */
  _waitForViewer() {
    return new Promise((resolve) => {
      const itemCount = this.viewer.world.getItemCount();
      const hasDrawer = !!(this.viewer.drawer && this.viewer.drawer.canvas);

      if (itemCount > 0 || hasDrawer) {
        resolve();
      } else {
        this.viewer.addOnceHandler('open', () => resolve());
      }
    });
  }

  /**
   * Resize overlay canvas to match OSD canvas
   */
  _resizeCanvas() {
    const osdCanvas = this.viewer.drawer.canvas;
    const rect = osdCanvas.getBoundingClientRect();

    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    if (this.gl) {
      // Set viewport to match canvas size in physical pixels
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /**
   * Handle viewer resize events
   */
  _onViewerResize() {
    this._resizeCanvas();
  }

  /**
   * Handle viewer open events, re-render once the tiled image is available
   * so the viewport matrix can be computed correctly.
   */
  _onViewerOpen() {
    if (this.isEnabled && this.isInitialized && this.pointData && this.pointData.count > 0) {
      this._render();
    }
  }

  /**
   * Initialize WebGL shaders for scatter plot rendering
   */
  async _initShaders() {
    const gl = this.gl;

    // Vertex shader: transforms points from image coords to clip space
    const vertexShaderSource = `#version 300 es
      precision highp float;

      // Input attributes
      in vec2 a_position;     // Point position in image pixel coordinates [0, imgW] x [0, imgH]
      in vec4 a_color;        // Point color (RGBA)

      // Uniforms for viewport transformation
      uniform mat3 u_matrix;  // Transformation matrix from image pixel coords to clip space
      uniform float u_pointSize; // Point size in pixels

      // Output to fragment shader
      out vec4 v_color;

      void main() {
        // Transform position using matrix
        vec3 pos = u_matrix * vec3(a_position, 1.0);
        gl_Position = vec4(pos.xy, 0.0, 1.0);

        // Set point size
        gl_PointSize = u_pointSize;

        // Pass color to fragment shader
        v_color = a_color;
      }
    `;

    // Fragment shader: renders colored points
    const fragmentShaderSource = `#version 300 es
      precision mediump float;

      in vec4 v_color;
      out vec4 outColor;

      void main() {
        // Make points circular
        vec2 coord = gl_PointCoord - vec2(0.5);
        if (length(coord) > 0.5) {
          discard;
        }

        outColor = v_color;
      }
    `;

    // Compile shaders
    const vertexShader = this._compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

    // Link program
    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(this.program);
      throw new Error('Failed to link shader program: ' + info);
    }

    // Get attribute and uniform locations
    this.locations = {
      position: gl.getAttribLocation(this.program, 'a_position'),
      color: gl.getAttribLocation(this.program, 'a_color'),
      matrix: gl.getUniformLocation(this.program, 'u_matrix'),
      pointSize: gl.getUniformLocation(this.program, 'u_pointSize'),
    };
  }

  /**
   * Compile a WebGL shader
   */
  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error('Failed to compile shader: ' + info);
    }

    return shader;
  }

  /**
   * Initialize WebGL buffers
   */
  _initBuffers() {
    const gl = this.gl;

    // Create buffers for positions and colors
    this.buffers.position = gl.createBuffer();
    this.buffers.color = gl.createBuffer();

    // Create VAO for efficient rendering
    this.vao = gl.createVertexArray();
  }

  /**
   * Update scatter plot data
   *
   * @param {Object} data: Point data
   * @param {Float32Array} data.positions: Point positions [x1, y1, x2, y2, ...]
   * @param {Uint8Array} data.colors: Point colors [r1, g1, b1, a1, r2, g2, b2, a2, ...]
   * @param {number} data.count: Number of points
   */
  setPointData(data) {
    this.pointData = data;
    this.pointsNeedUpdate = true;

    if (this.isInitialized && this.isEnabled) {
      this._render();
    }
  }

  /**
   * Set transformation matrix for coordinate mapping
   *
   * @param {Object} transform: Transformation object with functions
   */
  setTransform(transform) {
    this.transformMatrix = transform;
  }

  /**
   * Set custom image size (for custom tile sources)
   *
   * @param {Object} size: Image size {x: width, y: height}
   */
  setImageSize(size) {
    if (!this.options.imageSize) {
      this.options.imageSize = {};
    }
    this.options.imageSize.x = size.x;
    this.options.imageSize.y = size.y;
  }

  /**
   * Update point buffers with new data
   */
  _updatePointBuffers() {
    if (!this.pointData || !this.pointsNeedUpdate) return;

    const gl = this.gl;
    const { positions, colors } = this.pointData;

    // Upload position data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

    // Upload color data
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);

    this.pointsNeedUpdate = false;
  }

  /**
   * Called on every OpenSeadragon animation frame
   */
  _onViewerUpdate() {
    if (!this.isEnabled || !this.isInitialized || !this.pointData) return;

    this._render();
  }

  /**
   * Convert OSD viewport to WebGL transformation matrix.
   * Transforms from image pixel coordinates to clip space.
   */
  _getViewportMatrix() {
    const viewer = this.viewer;
    const viewport = viewer.viewport;

    // Get image size in pixels
    const tiledImage = viewer.world.getItemAt(0);
    if (!tiledImage) {
      console.warn('OSDWebGLOverlay: No tiled image available yet');
      return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]); // Identity matrix
    }
    const imageSize = tiledImage.getContentSize();

    // Use custom image size if provided (for custom tile sources where getContentSize returns 1x1)
    // Otherwise use the content size from OpenSeadragon
    const imgW = (this.options.imageSize?.x) || imageSize.x;
    const imgH = (this.options.imageSize?.y) || imageSize.y;

    // Get device pixel ratio and canvas physical size
    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = this.canvas.width;  // Physical pixels
    const canvasHeight = this.canvas.height;  // Physical pixels

    // Use OpenSeadragon's coordinate conversion functions
    // These account for zoom, pan, rotation, aspect ratio fitting, etc.

    // Sample two points to determine the transformation:
    // Point 1: top-left of image (0, 0) in image pixels
    // Point 2: bottom-right of image (imgW, imgH) in image pixels

    // Convert image pixel coordinates to viewport coordinates (normalized [0,1])
    const topLeft = tiledImage.imageToViewportCoordinates(0, 0);
    const bottomRight = tiledImage.imageToViewportCoordinates(imgW, imgH);

    // Convert viewport coordinates to viewer element coordinates (CSS pixels)
    const topLeftScreen = viewport.viewportToViewerElementCoordinates(topLeft);
    const bottomRightScreen = viewport.viewportToViewerElementCoordinates(bottomRight);

    // Convert to physical pixels
    const topLeftPhys = {
      x: topLeftScreen.x * dpr,
      y: topLeftScreen.y * dpr
    };
    const bottomRightPhys = {
      x: bottomRightScreen.x * dpr,
      y: bottomRightScreen.y * dpr
    };

    // Calculate scale: how many clip-space units per image pixel
    // The image spans from topLeftPhys to bottomRightPhys on screen (in physical pixels)
    // Map image pixels [0, imgW] x [0, imgH] to this screen region
    // Then convert screen region to clip space [-1, 1]

    // Scale factor: image pixels → screen physical pixels → clip space
    const pixelsToScreenX = (bottomRightPhys.x - topLeftPhys.x) / imgW;  // pixels/image-pixel
    const pixelsToScreenY = (bottomRightPhys.y - topLeftPhys.y) / imgH;

    const scaleX = (pixelsToScreenX / canvasWidth) * 2.0;   // Convert to clip space units
    const scaleY = -(pixelsToScreenY / canvasHeight) * 2.0;  // Negative for Y-flip

    // Calculate translate: where image pixel (0, 0) maps to in clip space
    // For X: screen coords [0, canvasWidth] → clip space [-1, 1]
    //   clipX = (screenX / canvasWidth) * 2.0: 1.0
    const translateX = (topLeftPhys.x / canvasWidth) * 2.0 - 1.0;

    // For Y: screen coords [0, canvasHeight] → clip space [1, -1] (flipped!)
    //   clipY = 1.0: (screenY / canvasHeight) * 2.0
    // This is equivalent to: -(screenY / canvasHeight * 2.0: 1.0)
    const translateY = 1.0 - (topLeftPhys.y / canvasHeight) * 2.0;

    // Return as column-major 3x3 matrix (WebGL format)
    return new Float32Array([
      scaleX, 0, 0,
      0, scaleY, 0,
      translateX, translateY, 1
    ]);
  }

  /**
   * Render the scatter plot
   */
  _render() {
    const gl = this.gl;

    // Check if tiled image is available (required for viewport matrix calculation)
    const tiledImage = this.viewer?.world?.getItemAt(0);
    if (!tiledImage) {
      // Skip rendering until the tiled image is available; re-triggered by the "open" event handler
      return;
    }

    // Update buffers if needed
    this._updatePointBuffers();

    if (!this.pointData || this.pointData.count === 0) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    // Clear with transparent background
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Enable blending for transparency
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // Use shader program
    gl.useProgram(this.program);

    // Get viewport transformation matrix
    const matrix = this._getViewportMatrix();
    gl.uniformMatrix3fv(this.locations.matrix, false, matrix);

    // Set point size with zoom scaling, same gradient as Xenium single-sample view (SpatialPlotView):
    // smaller points when zoomed out, gradiently bigger when user zooms in (radiusScale = 1.5^zoomDelta, cap 12x).
    const zoom = this.viewer.viewport.getZoom(true);
    const basePointSize = this.options.pointSize || 1.5;

    // OSD zoom: 1 = image fits viewport. Use baseZoom so fit-to-view is "zoomed out" (smaller points).
    const INITIAL_ZOOM_OFFSET = 2.0;
    const baseZoom = INITIAL_ZOOM_OFFSET;
    const zoomDelta = zoom - baseZoom;

    const zoomScalePerLevel = this.options.zoomScalePerLevel || 1.5;
    const minZoomScale = this.options.minZoomScale || 0.3;
    const maxZoomScale = this.options.maxZoomScale || 12;

    const zoomScale = Math.min(
      Math.max(Math.pow(zoomScalePerLevel, zoomDelta), minZoomScale),
      maxZoomScale
    );

    const pointSize = basePointSize * zoomScale;

    gl.uniform1f(this.locations.pointSize, pointSize);

    // Bind VAO
    gl.bindVertexArray(this.vao);

    // Set up position attribute
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);

    // Set up color attribute (normalized unsigned bytes)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
    gl.enableVertexAttribArray(this.locations.color);
    gl.vertexAttribPointer(this.locations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    // Draw points
    gl.drawArrays(gl.POINTS, 0, this.pointData.count);

    // Cleanup
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  /**
   * Enable/disable rendering
   */
  setEnabled(enabled) {
    this.isEnabled = enabled;
    if (!enabled && this.gl) {
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
  }

  /**
   * Destroy the overlay and clean up resources
   */
  destroy() {
    if (!this.isInitialized) return;

    const gl = this.gl;

    // Delete WebGL resources
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.buffers.position) gl.deleteBuffer(this.buffers.position);
    if (this.buffers.color) gl.deleteBuffer(this.buffers.color);
    if (this.program) gl.deleteProgram(this.program);

    // Remove canvas
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this.isInitialized = false;
    this.gl = null;

  }
}

export default OSDWebGLOverlay;
