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

    this.transformMatrix = null;
    this.scaleFactor = 1.0;
  }

  async init() {
    if (this.isInitialized) return;

    await this._waitForViewer();

    const osdCanvas = this.viewer.drawer.canvas;

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.pointerEvents = 'none';

    osdCanvas.parentNode.insertBefore(this.canvas, osdCanvas.nextSibling);

    this._resizeCanvas();

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

    await this._initShaders();

    this._initBuffers();

    this.viewer.addHandler('animation', this._onViewerUpdate.bind(this));
    this.viewer.addHandler('resize', this._onViewerResize.bind(this));
    this.viewer.addHandler('open', this._onViewerOpen.bind(this));

    this.isInitialized = true;
    console.log('OSD WebGL Overlay initialized');
  }

  _waitForViewer() {
    return new Promise((resolve) => {
      const itemCount = this.viewer.world.getItemCount();
      const hasDrawer = !!(this.viewer.drawer && this.viewer.drawer.canvas);

      console.log('WebGL _waitForViewer: Checking viewer state', {
        itemCount,
        hasDrawer,
        hasWorld: !!this.viewer.world,
      });

      if (itemCount > 0) {
        console.log('WebGL _waitForViewer: Viewer already has items, resolving immediately');
        resolve();
      } else {
        if (hasDrawer) {
          console.log('WebGL _waitForViewer: Viewer has drawer, resolving immediately');
          resolve();
        } else {
          console.log('WebGL _waitForViewer: Waiting for "open" event');
          this.viewer.addOnceHandler('open', () => {
            console.log('WebGL _waitForViewer: "open" event fired, resolving');
            resolve();
          });
        }
      }
    });
  }

  _resizeCanvas() {
    const osdCanvas = this.viewer.drawer.canvas;
    const rect = osdCanvas.getBoundingClientRect();

    this.canvas.style.width = rect.width + 'px';
    this.canvas.style.height = rect.height + 'px';

    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;

    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _onViewerResize() {
    this._resizeCanvas();
  }

  _onViewerOpen() {
    console.log('WebGL _onViewerOpen: Viewer opened, checking if we should render', {
      isEnabled: this.isEnabled,
      isInitialized: this.isInitialized,
      hasPointData: !!this.pointData,
      pointCount: this.pointData?.count,
    });
    if (this.isEnabled && this.isInitialized && this.pointData && this.pointData.count > 0) {
      console.log('WebGL _onViewerOpen: Triggering render now that viewer is ready');
      this._render();
    }
  }

  async _initShaders() {
    const gl = this.gl;

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

    const vertexShader = this._compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

    this.program = gl.createProgram();
    gl.attachShader(this.program, vertexShader);
    gl.attachShader(this.program, fragmentShader);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(this.program);
      throw new Error('Failed to link shader program: ' + info);
    }

    this.locations = {
      position: gl.getAttribLocation(this.program, 'a_position'),
      color: gl.getAttribLocation(this.program, 'a_color'),
      matrix: gl.getUniformLocation(this.program, 'u_matrix'),
      pointSize: gl.getUniformLocation(this.program, 'u_pointSize'),
    };
  }

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

  _initBuffers() {
    const gl = this.gl;

    this.buffers.position = gl.createBuffer();
    this.buffers.color = gl.createBuffer();

    this.vao = gl.createVertexArray();
  }

  setPointData(data) {
    this.pointData = data;
    this.pointsNeedUpdate = true;

    if (this.isInitialized && this.isEnabled) {
      this._render();
    }
  }

  setTransform(transform) {
    this.transformMatrix = transform;
  }

  setImageSize(size) {
    if (!this.options.imageSize) {
      this.options.imageSize = {};
    }
    this.options.imageSize.x = size.x;
    this.options.imageSize.y = size.y;
    console.log('WebGL Overlay - Image size updated:', size);
  }

  _updatePointBuffers() {
    if (!this.pointData || !this.pointsNeedUpdate) return;

    const gl = this.gl;
    const { positions, colors } = this.pointData;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
    gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);

    this.pointsNeedUpdate = false;
  }

  _onViewerUpdate() {
    if (!this.isEnabled || !this.isInitialized || !this.pointData) return;

    this._render();
  }

  _getViewportMatrix() {
    const viewer = this.viewer;
    const viewport = viewer.viewport;

    const tiledImage = viewer.world.getItemAt(0);
    if (!tiledImage) {
      console.warn('OSDWebGLOverlay: No tiled image available yet');
      return new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    }
    const imageSize = tiledImage.getContentSize();

    const imgW = (this.options.imageSize?.x) || imageSize.x;
    const imgH = (this.options.imageSize?.y) || imageSize.y;

    const dpr = window.devicePixelRatio || 1;
    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;

    const topLeft = tiledImage.imageToViewportCoordinates(0, 0);
    const bottomRight = tiledImage.imageToViewportCoordinates(imgW, imgH);

    const topLeftScreen = viewport.viewportToViewerElementCoordinates(topLeft);
    const bottomRightScreen = viewport.viewportToViewerElementCoordinates(bottomRight);

    const topLeftPhys = {
      x: topLeftScreen.x * dpr,
      y: topLeftScreen.y * dpr
    };
    const bottomRightPhys = {
      x: bottomRightScreen.x * dpr,
      y: bottomRightScreen.y * dpr
    };

    const pixelsToScreenX = (bottomRightPhys.x - topLeftPhys.x) / imgW;
    const pixelsToScreenY = (bottomRightPhys.y - topLeftPhys.y) / imgH;

    const scaleX = (pixelsToScreenX / canvasWidth) * 2.0;
    const scaleY = -(pixelsToScreenY / canvasHeight) * 2.0;

    const translateX = (topLeftPhys.x / canvasWidth) * 2.0 - 1.0;

    const translateY = 1.0 - (topLeftPhys.y / canvasHeight) * 2.0;

    if (!this._lastMatrixCalcLog || Date.now() - this._lastMatrixCalcLog > 2000) {
      const zoom = viewport.getZoom(true);

      const test00_clipX = scaleX * 0 + translateX;
      const test00_clipY = scaleY * 0 + translateY;

      const testWH_clipX = scaleX * imgW + translateX;
      const testWH_clipY = scaleY * imgH + translateY;

      console.log('WebGL Matrix Calculation (Y-FIX):', {
        zoom: zoom.toFixed(3),
        imgW, imgH,
        canvasWidth, canvasHeight,
        dpr: dpr.toFixed(2),
        topLeft: {
          viewport: `(${topLeft.x.toFixed(3)}, ${topLeft.y.toFixed(3)})`,
          screen: `(${topLeftScreen.x.toFixed(1)}, ${topLeftScreen.y.toFixed(1)})`,
          phys: `(${topLeftPhys.x.toFixed(1)}, ${topLeftPhys.y.toFixed(1)})`
        },
        bottomRight: {
          viewport: `(${bottomRight.x.toFixed(3)}, ${bottomRight.y.toFixed(3)})`,
          screen: `(${bottomRightScreen.x.toFixed(1)}, ${bottomRightScreen.y.toFixed(1)})`,
          phys: `(${bottomRightPhys.x.toFixed(1)}, ${bottomRightPhys.y.toFixed(1)})`
        },
        pixelsToScreenX: pixelsToScreenX.toFixed(6),
        pixelsToScreenY: pixelsToScreenY.toFixed(6),
        scaleX: scaleX.toExponential(3),
        scaleY: scaleY.toExponential(3),
        translateX: translateX.toFixed(6),
        translateY: translateY.toFixed(6),
        test_imgPixel_0_0_to_clip: `(${test00_clipX.toFixed(3)}, ${test00_clipY.toFixed(3)})`,
        test_imgPixel_W_H_to_clip: `(${testWH_clipX.toFixed(3)}, ${testWH_clipY.toFixed(3)})`,
        note: 'Fixed Y translation - (0,0) and (W,H) should map to visible clip space when in view',
      });
      this._lastMatrixCalcLog = Date.now();
    }

    return new Float32Array([
      scaleX, 0, 0,
      0, scaleY, 0,
      translateX, translateY, 1
    ]);
  }

  _render() {
    const gl = this.gl;

    const tiledImage = this.viewer?.world?.getItemAt(0);
    if (!tiledImage) {
      console.log('WebGL _render: No tiled image available, skipping render. Viewer state:', {
        hasViewer: !!this.viewer,
        hasWorld: !!this.viewer?.world,
        worldItemCount: this.viewer?.world?.getItemCount(),
        viewerId: this.viewer?.id,
        hasCanvas: !!this.viewer?.canvas,
        isViewerDestroyed: !this.viewer?.drawer,
      });
      return;
    }

    this._updatePointBuffers();

    if (!this.pointData || this.pointData.count === 0) {
      console.log('WebGL _render: No point data, clearing canvas');
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }

    if (!this._hasLoggedRender) {
      console.log('WebGL _render: Rendering points', {
        pointCount: this.pointData.count,
        hasPositions: !!this.pointData.positions,
        hasColors: !!this.pointData.colors,
      });
      this._hasLoggedRender = true;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.useProgram(this.program);

    const matrix = this._getViewportMatrix();
    
    if (!this._lastMatrixDebugLog || Date.now() - this._lastMatrixDebugLog > 2000) {
      console.log('WebGL Matrix Values (CRITICAL DEBUG):', {
        scaleX: matrix[0].toFixed(6),
        scaleY: matrix[4].toFixed(6),
        translateX: matrix[6].toFixed(6),
        translateY: matrix[7].toFixed(6),
        matrix: Array.from(matrix).map(v => v.toFixed(4)),
        note: 'If translateY is wrong or scaleY is wrong, scatter plot will be compressed!',
      });
      this._lastMatrixDebugLog = Date.now();
    }
    
    gl.uniformMatrix3fv(this.locations.matrix, false, matrix);

    if (!this._lastMatrixLog || Date.now() - this._lastMatrixLog > 2000) {
      const tiledImage = this.viewer.world.getItemAt(0);
      if (!tiledImage) {
        return;
      }
      const imageSize = tiledImage.getContentSize();
      const viewport = this.viewer.viewport;

      const containerSize = viewport.getContainerSize();

      const imgTopLeft = new OpenSeadragon.Point(0, 0);
      const imgBottomRight = new OpenSeadragon.Point(1, 1);
      const imgTopLeftPixel = viewport.viewportToViewerElementCoordinates(imgTopLeft);
      const imgBottomRightPixel = viewport.viewportToViewerElementCoordinates(imgBottomRight);

      const imgScreenWidth = imgBottomRightPixel.x - imgTopLeftPixel.x;
      const imgScreenHeight = imgBottomRightPixel.y - imgTopLeftPixel.y;
      const imgScreenOffsetX = imgTopLeftPixel.x;
      const imgScreenOffsetY = imgTopLeftPixel.y;

      console.log('WebGL Overlay - Debug Info:', {
        canvasSize: { w: this.canvas.width, h: this.canvas.height },
        canvasCSS: { w: this.canvas.clientWidth, h: this.canvas.clientHeight },
        imageSize: { w: imageSize.x, h: imageSize.y },
        imageAspect: (imageSize.x / imageSize.y).toFixed(3),
        containerSize: { w: containerSize.x, h: containerSize.y },
        containerAspect: (containerSize.x / containerSize.y).toFixed(3),
        imageScreenBounds: {
          width: imgScreenWidth.toFixed(1),
          height: imgScreenHeight.toFixed(1),
          offsetX: imgScreenOffsetX.toFixed(1),
          offsetY: imgScreenOffsetY.toFixed(1),
          note: 'Where the full image [0,1]x[0,1] appears on screen (from OSD)',
        },
        ratios: {
          screenWidth_vs_container: (imgScreenWidth / containerSize.x).toFixed(3),
          screenHeight_vs_container: (imgScreenHeight / containerSize.y).toFixed(3),
          note: 'These show how much of container is filled by image',
        },
        transformation: {
          scaleX: matrix[0].toExponential(3),
          scaleY: matrix[4].toExponential(3),
          translateX: matrix[6].toFixed(3),
          translateY: matrix[7].toFixed(3),
          note: 'Matrix transforms image pixels → clip space',
        },
        pointCount: this.pointData?.count || 0,
      });
      this._lastMatrixLog = Date.now();
    }

    const zoom = this.viewer.viewport.getZoom(true);
    const basePointSize = this.options.pointSize || 1.5;

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

    gl.bindVertexArray(this.vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
    gl.enableVertexAttribArray(this.locations.position);
    gl.vertexAttribPointer(this.locations.position, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.color);
    gl.enableVertexAttribArray(this.locations.color);
    gl.vertexAttribPointer(this.locations.color, 4, gl.UNSIGNED_BYTE, true, 0, 0);

    gl.drawArrays(gl.POINTS, 0, this.pointData.count);

    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
  }

  setEnabled(enabled) {
    this.isEnabled = enabled;
    if (!enabled && this.gl) {
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }
  }

  destroy() {
    if (!this.isInitialized) return;

    const gl = this.gl;

    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.buffers.position) gl.deleteBuffer(this.buffers.position);
    if (this.buffers.color) gl.deleteBuffer(this.buffers.color);
    if (this.program) gl.deleteProgram(this.program);

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    this.isInitialized = false;
    this.gl = null;

    console.log('OSD WebGL Overlay destroyed');
  }
}

export default OSDWebGLOverlay;
