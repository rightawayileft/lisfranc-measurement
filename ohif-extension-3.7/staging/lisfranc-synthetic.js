window.config = {
  name: 'lisfranc-synthetic-3.7',
  routerBasename: '/',
  extensions: [],
  modes: [],
  showStudyList: false,
  showWarningMessageForCrossOrigin: false,
  showCPUFallbackMessage: false,
  showLoadingIndicator: true,
  maxNumberOfWebWorkers: 2,
  defaultDataSourceName: 'dicomlocal',
  dataSources: [{
    namespace: '@ohif/extension-default.dataSourcesModule.dicomlocal',
    sourceName: 'dicomlocal',
    configuration: { friendlyName: 'Synthetic local DICOM' },
  }],
};
