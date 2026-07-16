/**
 * Utility functions for loading 10x data
 */

/**
 * Load 10x MatrixMarket format data
 * @param {string} folderPath: Path to folder containing matrix.mtx, features.tsv, barcodes.tsv
 * @returns {Promise<object>}: Loaded data object
 */
export async function load10xMatrixMarket(folderPath) {
  if (!window.electron) {
    throw new Error('File system access requires Electron');
  }

  try {
    // List files in directory
    const result = await window.electron.listDirectory(folderPath);
    
    if (!result.success) {
      throw new Error(result.error);
    }

    // Find the matrix, features, and barcodes files
    const files = result.files;
    const matrixFile = files.find(f => 
      f.toLowerCase().includes('matrix') && 
      (f.endsWith('.mtx') || f.endsWith('.mtx.gz'))
    );
    const featuresFile = files.find(f => 
      (f.toLowerCase().includes('features') || f.toLowerCase().includes('genes')) &&
      (f.endsWith('.tsv') || f.endsWith('.tsv.gz'))
    );
    const barcodesFile = files.find(f => 
      f.toLowerCase().includes('barcodes') &&
      (f.endsWith('.tsv') || f.endsWith('.tsv.gz'))
    );

    if (!matrixFile) {
      throw new Error('Matrix file not found');
    }

    return {
      format: '10X MatrixMarket',
      matrixFile,
      featuresFile,
      barcodesFile,
      path: folderPath,
    };

  } catch (error) {
    console.error('Error loading 10x MatrixMarket data:', error);
    throw error;
  }
}

/**
 * Load 10x HDF5 format data
 * @param {string} filePath: Path to .h5 file
 * @returns {Promise<object>}: Loaded data object
 */
export async function load10xHDF5(filePath) {
  if (!window.electron) {
    throw new Error('File system access requires Electron');
  }

  try {
    const result = await window.electron.readFile(filePath);
    
    if (!result.success) {
      throw new Error(result.error);
    }

    return {
      format: '10X HDF5',
      file: filePath,
      data: result.data,
    };

  } catch (error) {
    console.error('Error loading 10x HDF5 data:', error);
    throw error;
  }
}

/**
 * Detect the format of 10x data
 * @param {string} path: Path to file or folder
 * @returns {Promise<string>}: Detected format ('h5', 'mtx', or 'unknown')
 */
export async function detect10xFormat(path) {
  if (!window.electron) {
    return 'unknown';
  }

  try {
    // Check if it's a file or directory
    const isDir = await window.electron.pathExists(path);
    
    if (!isDir) {
      return 'unknown';
    }

    // If it's a file
    if (path.endsWith('.h5') || path.endsWith('.hdf5')) {
      return 'h5';
    }

    // If it's a directory, check for mtx files
    const result = await window.electron.listDirectory(path);
    
    if (result.success) {
      const hasMtx = result.files.some(f => 
        f.toLowerCase().includes('matrix') &&
        (f.endsWith('.mtx') || f.endsWith('.mtx.gz'))
      );
      
      if (hasMtx) {
        return 'mtx';
      }
    }

    return 'unknown';

  } catch (error) {
    console.error('Error detecting format:', error);
    return 'unknown';
  }
}

