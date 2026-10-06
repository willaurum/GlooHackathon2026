import { createContext, useContext } from 'react';

// The church the site is showing, set up in App.jsx:
// { slug, name, city, missing, demo, ready, staff, source, choose(slug), go(route), link(route), refresh() }.
// `ready` is false while the church API does not serve this church yet (an older deploy).
export const ChurchContext = createContext(null);
export const useChurch = () => useContext(ChurchContext);
