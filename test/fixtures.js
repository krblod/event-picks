// Sample Discovery API v2 responses (shape as documented; values made up).
'use strict';

function venue(id, name, line1, city, state, lat, lon, upcoming) {
  return {
    id, name, type: 'venue', url: 'https://www.ticketmaster.com/venue/' + id,
    address: { line1 }, city: { name: city }, state: { name: state, stateCode: state },
    country: { countryCode: 'US' },
    location: { latitude: String(lat), longitude: String(lon) },
    upcomingEvents: upcoming == null ? undefined : { _total: upcoming, ticketmaster: upcoming }
  };
}

const venues = {
  revolution: venue('KovZpZA1', 'Revolution Hall', '1300 SE Stark St', 'Portland', 'OR', 45.5195, -122.6527, 14),
  dantes: venue('KovZpZA2', "Dante's", '350 W Burnside St', 'Portland', 'OR', 45.5231, -122.6729, 22),
  helium: venue('KovZpZA3', 'Helium Comedy Club - Portland', '1510 SE 9th Ave', 'Portland', 'OR', 45.5116, -122.6565, 0),
  heliumPhilly: venue('KovZpZA9', 'Helium Comedy Club - Philadelphia', '2031 Sansom St', 'Philadelphia', 'PA', 39.9512, -75.1741, 30),
  aladdin: venue('KovZpZA4', 'Aladdin Theater', '3017 SE Milwaukie Ave', 'Portland', 'OR', 45.5009, -122.6564, 9),
  vancouver: venue('KovZpZA5', 'Revolution Hall Annex', '1 Main St', 'Vancouver', 'WA', 45.6387, -122.6615, 2)
};

function venuesPage(list) {
  return { _embedded: { venues: list }, page: { size: 50, totalElements: list.length, totalPages: 1, number: 0 } };
}

function event(id, name, date, time, venueObj, opts) {
  const o = opts || {};
  return {
    id, name, type: 'event', url: o.url === undefined ? 'https://www.ticketmaster.com/event/' + id : o.url,
    dates: { start: { localDate: date, localTime: time, timeTBA: !time }, status: { code: o.status || 'onsale' } },
    classifications: o.classifications || [{ primary: true, segment: { name: 'Music' }, genre: { name: 'Rock' }, subGenre: { name: 'Indie Rock' } }],
    priceRanges: o.priceRanges,
    _embedded: {
      venues: [{ id: venueObj.id, name: venueObj.name }],
      attractions: o.attractions || [{ id: 'att-' + id, name, upcomingEvents: { _total: 12 } }]
    }
  };
}

const COMEDY = [{ primary: true, segment: { name: 'Arts & Theatre' }, genre: { name: 'Comedy' }, subGenre: { name: 'Comedy' } }];
const TALK = [{ primary: true, segment: { name: 'Arts & Theatre' }, genre: { name: 'Spectacular' }, subGenre: { name: 'Undefined' } }];

function eventsPage(list, number, totalPages) {
  return {
    _embedded: list.length ? { events: list } : undefined,
    page: { size: 200, totalElements: list.length, totalPages: totalPages == null ? 1 : totalPages, number: number || 0 }
  };
}

module.exports = { venues, venuesPage, event, eventsPage, COMEDY, TALK };
