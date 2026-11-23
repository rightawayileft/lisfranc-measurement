import { createElement, useEffect, useState } from 'react';
import { LisfrancWorkspaces } from './workspaces.js';

export const id = '@msk/extension-lisfranc';

export default {
  id,
  getPanelModule({ extensionManager, servicesManager }) {
    return [{
      name: 'lisfranc',
      iconName: 'tab-linear',
      iconLabel: 'Lisfranc',
      label: 'Lisfranc',
      component: function Panel() {
        const [cornerstone, setCornerstone] = useState(null);
        useEffect(() => {
          const module = extensionManager.getModuleEntry('@ohif/extension-cornerstone.utilityModule.common');
          setCornerstone(module?.exports?.getCornerstoneLibraries()?.cornerstone ?? null);
        }, []);
        return createElement(LisfrancWorkspaces, { cornerstone, services: servicesManager.services });
      },
    }];
  },
};
