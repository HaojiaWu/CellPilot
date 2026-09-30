import React, { useState, useCallback } from 'react';
import { Button, Dialog, FormGroup, Callout, Spinner } from '@blueprintjs/core';

const HistologyImageDialog = ({ onImageLoaded, onClose, isOpen, onLoadingChange }) => {
  const [imagePath, setImagePath] = useState(null);
  const [matrixPath, setMatrixPath] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [imageFileName, setImageFileName] = useState('');
  const [matrixFileName, setMatrixFileName] = useState('');

  const handleSelectImage = useCallback(async () => {
    if (!window.electron) {
      setError('File selection requires Electron environment');
      return;
    }

    try {
      const path = await window.electron.selectHistologyImage();
      if (path) {
        setImagePath(path);
        setImageFileName(path.split(/[/\\]/).pop());
        setError(null);
      }
    } catch (err) {
      setError(`Failed to select image: ${err.message}`);
    }
  }, []);

  const handleSelectMatrix = useCallback(async () => {
    if (!window.electron) {
      setError('File selection requires Electron environment');
      return;
    }

    try {
      const path = await window.electron.selectTransformationMatrix();
      if (path) {
        setMatrixPath(path);
        setMatrixFileName(path.split(/[/\\]/).pop());
        setError(null);
      }
    } catch (err) {
      setError(`Failed to select matrix: ${err.message}`);
    }
  }, []);

  const handleLoadImage = useCallback(async () => {
    if (!imagePath) {
      setError('Please select a histology image first');
      return;
    }

    if (!window.electron) {
      setError('Image loading requires Electron environment');
      return;
    }

    setLoading(true);
    setError(null);
    
    if (onLoadingChange) {
      onLoadingChange(true);
    }

    try {
      console.log('Loading histology image with transformation matrix...');
      
      let transformMatrix = null;
      if (matrixPath) {
        const matrixResult = await window.electron.loadTransformationMatrix(matrixPath);
        if (!matrixResult.success) {
          throw new Error(`Failed to load transformation matrix: ${matrixResult.error}`);
        }
        transformMatrix = matrixResult.matrix;
        console.log('Loaded transformation matrix:', transformMatrix);
      }

      console.log('Converting image to DZI format with transformation...');
      const dziResult = await window.electron.convertTiffToDzi(imagePath, transformMatrix);

      if (!dziResult || !dziResult.success) {
        throw new Error(dziResult?.error || 'Failed to convert image to DZI');
      }

      console.log('Histology image loaded successfully:', dziResult);

      if (onImageLoaded) {
        onImageLoaded({
          dziUrl: dziResult.dziUrl,
          width: dziResult.width,
          height: dziResult.height,
          transformMatrix: transformMatrix,
          imagePath: imagePath,
          matrixPath: matrixPath,
        });
      }

      if (onClose) {
        onClose();
      }
    } catch (err) {
      console.error('Error loading histology image:', err);
      setError(`Failed to load image: ${err.message}`);
    } finally {
      setLoading(false);
      if (onLoadingChange) {
        onLoadingChange(false);
      }
    }
  }, [imagePath, matrixPath, onImageLoaded, onClose, onLoadingChange]);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Add Histology Image"
      style={{ width: 500 }}
    >
      <div className="bp4-dialog-body">
        <Callout intent="primary" style={{ marginBottom: 15 }}>
          <strong>Load Histology Image with Alignment</strong>
          <p style={{ marginTop: 8, marginBottom: 0 }}>
            Load an unaligned histology image (TIFF) and apply a 3×3 transformation matrix (from QuPath or other alignment tools).
            The image will be automatically transformed to align with your spatial data before rendering.
          </p>
          <p style={{ marginTop: 8, marginBottom: 0, fontSize: '0.9em' }}>
            <strong>Transformation Matrix Format:</strong> CSV file with 3 rows and 3 columns: [[a, b, tx], [c, d, ty], [0, 0, 1]]
          </p>
        </Callout>

        {error && (
          <Callout intent="danger" style={{ marginBottom: 15 }}>
            {error}
          </Callout>
        )}

        <FormGroup
          label="Histology Image (TIFF)"
          labelInfo="(required)"
          helperText="Unaligned histology image in TIFF format"
        >
          <div style={{ display: 'flex', gap: 10 }}>
            <Button
              icon="media"
              text="Select Image..."
              onClick={handleSelectImage}
              disabled={loading}
            />
            {imageFileName && <span style={{ lineHeight: '30px' }}>{imageFileName}</span>}
          </div>
        </FormGroup>

        <FormGroup
          label="Transformation Matrix (CSV)"
          labelInfo="(optional)"
          helperText="3×3 affine transformation matrix from QuPath or other alignment tools. If omitted, image is assumed to be pre-aligned."
        >
          <div style={{ display: 'flex', gap: 10 }}>
            <Button
              icon="th"
              text="Select Matrix..."
              onClick={handleSelectMatrix}
              disabled={loading}
            />
            {matrixFileName && <span style={{ lineHeight: '30px' }}>{matrixFileName}</span>}
          </div>
        </FormGroup>
      </div>

      <div className="bp4-dialog-footer">
        <div className="bp4-dialog-footer-actions">
          <Button text="Cancel" onClick={onClose} disabled={loading} />
          <Button
            intent="primary"
            text={loading ? 'Loading...' : 'Load Image'}
            onClick={handleLoadImage}
            disabled={!imagePath || loading}
            icon={loading ? <Spinner size={16} /> : 'import'}
          />
        </div>
      </div>
    </Dialog>
  );
};

export default HistologyImageDialog;

