import React from 'react';
import { Button, Icon } from '@blueprintjs/core';

/**
 * Dialog shown when CellPilot detects a saved analysis (cellpilot_results.json)
 * in the input folder. User can load the previous results or start a new analysis.
 */
const PreviousResultsDialog = ({ previousResults, onChoice }) => {
  if (!previousResults) return null;

  const { timestamp, nCells, nClusters, modality, clusterLabelMap } = previousResults;
  const savedDate = timestamp ? new Date(timestamp).toLocaleString() : 'unknown date';
  const labelCount = clusterLabelMap ? Object.keys(clusterLabelMap).length : 0;

  return (
    <div style={{
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.55)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        background: '#fff',
        borderRadius: 8,
        padding: '28px 32px',
        maxWidth: 440,
        width: '90%',
        boxShadow: '0 8px 32px rgba(0,0,0,0.22)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <Icon icon="history" size={22} color="#137cbd" />
          <span style={{ fontSize: 17, fontWeight: 700, color: '#1a1a2e' }}>
            Previous Analysis Found
          </span>
        </div>

        <p style={{ margin: '0 0 10px', color: '#444', fontSize: 14 }}>
          A saved analysis was found in this folder from <strong>{savedDate}</strong>.
        </p>

        <div style={{
          background: '#f5f8fa',
          borderRadius: 6,
          padding: '10px 14px',
          marginBottom: 20,
          fontSize: 13,
          color: '#555',
          lineHeight: 1.7,
        }}>
          {nCells != null && <div><strong>Cells:</strong> {nCells.toLocaleString()}</div>}
          {nClusters != null && <div><strong>Clusters:</strong> {nClusters}</div>}
          {labelCount > 0 && <div><strong>Cluster labels:</strong> {labelCount} renamed</div>}
          {modality && <div><strong>Modality:</strong> {modality}</div>}
        </div>

        <p style={{ margin: '0 0 20px', color: '#444', fontSize: 13 }}>
          Would you like to restore the previous UMAP layout and cluster labels, or run a fresh analysis?
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button
            text="New Analysis"
            intent="none"
            onClick={() => onChoice(false)}
            style={{ minWidth: 120 }}
          />
          <Button
            text="Load Previous Results"
            intent="primary"
            icon="cloud-download"
            onClick={() => onChoice(true)}
            style={{ minWidth: 160 }}
          />
        </div>
      </div>
    </div>
  );
};

export default PreviousResultsDialog;
