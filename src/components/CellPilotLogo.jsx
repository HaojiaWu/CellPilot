import React from 'react';
import logoImage from '../assets/logo.png';

const CellPilotLogo = ({ size = 32, className = '' }) => {
  return (
    <img
      src={logoImage}
      alt="CellPilot Logo"
      width={size}
      height={size}
      className={className}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
      }}
    />
  );
};

export default CellPilotLogo;
