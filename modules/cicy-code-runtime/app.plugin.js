const { withGradleProperties } = require('@expo/config-plugins');

const KEY = 'expo.useLegacyPackaging';

module.exports = function withCicyCodeRuntime(config) {
  return withGradleProperties(config, (next) => {
    const properties = next.modResults;
    const existing = properties.find((entry) => entry.type === 'property' && entry.key === KEY);
    if (existing) {
      existing.value = 'true';
    } else {
      properties.push({ type: 'property', key: KEY, value: 'true' });
    }
    return next;
  });
};
