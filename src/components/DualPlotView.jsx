import React from 'react';
import PlotView from './PlotView';
import SpatialPlotView from './SpatialPlotView';
import './DualPlotView.css';

const DualPlotView = ({ activePlot, artifacts, dataInfo }) => {
  return (
    <div className="dual-plot-view">
      <div className="dual-plot-panel">
        <PlotView 
          activePlot={activePlot}
          artifacts={artifacts}
          dataInfo={dataInfo}
        />
      </div>
      <div className="dual-plot-panel">
        <SpatialPlotView 
          activePlot={activePlot}
          artifacts={artifacts}
          dataInfo={dataInfo}
        />
      </div>
    </div>
  );
};

export default DualPlotView;
