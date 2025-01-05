import { xml2json } from 'xml-js';

import { constants } from '../constants';

type RoomEvent = {
  _attributes: {
    guid: string;
    id: string;
  };
};

type Room = {
  _attributes: { name: string; slug: string };
  event: RoomEvent | RoomEvent[];
};

type Day = {
  _attributes: { index: number; date: string; start: string; end: string };
  room: Room[];
};

const typeData = constants.TYPES;

const buildings = constants.BUILDINGS;

function flattenData(element: unknown) {
  if (Array.isArray(element)) {
    return element.map(flattenData);
  }

  if (typeof element === 'object' && element !== null) {
    const keys = Object.keys(element);

    if (keys.length === 1) {
      const key = keys[0];
      if (key === 'value') {
        return element[key];
      }
    }

    const newElement = {};
    keys.forEach((e) => {
      newElement[e] = flattenData(element[e]);
    });
    return newElement;
  }

  return element;
}

async function parseData(text: string) {
  const data = await xml2json(text, {
    compact: true,
    ignoreDeclaration: true,
    ignoreInstruction: true,
    ignoreComment: true,
    ignoreDoctype: true,
    ignoreCdata: true,
    textFn: (value) => value.trim(),
  });

  const parsed = JSON.parse(data);
  const result = flattenData(parsed.schedule);

  return result;
}

const getRoomName = (name) => {
  if (name.startsWith('D.')) {
    return `${name} (online)`;
  }

  return name;
};

const getPersons = (persons) => {
  if (!persons.person) {
    return [];
  }

  if (Array.isArray(persons.person)) {
    return persons.person.map((person) => person._text);
  }

  return [persons.person._text];
};

const getLinkType = (url) => {
  if (url.endsWith('.mp4')) {
    return 'video/mp4';
  } else if (url.endsWith('.webm')) {
    return 'video/webm';
  } else {
    return null;
  }
};

const getLinks = (links) => {
  if (!links.link) {
    return [];
  }

  if (Array.isArray(links.link)) {
    return links.link.map((link) => ({
      href: link._attributes.href,
      title: link._text,
      type: getLinkType(link._attributes.href),
    }));
  }

  return [
    {
      href: links.link._attributes.href,
      title: links.link._text,
      type: getLinkType(links.link._attributes.href),
    },
  ];
};

const getText = (element) =>
  element && element?._text !== null ? element._text : element;

const getStatus = (title) => {
  if (title.includes('canceled')) {
    return 'canceled';
  } else if (title.includes('amendment')) {
    return 'amendment';
  } else {
    return 'running';
  }
};

const getTitle = (title, status) => {
  if (status === 'amendment') {
    return title?.substring(10) || title;
  }
  return title;
};

const getType = (event) => {
  const type = getText(event.type);
  if (!typeData[type]) {
    return 'other';
  }
  return type;
};

const getAttachments = (attachments) => {
  if (!attachments?.attachment) {
    return [];
  }

  if (Array.isArray(attachments.attachment)) {
    return attachments.attachment.map((attachment) => ({
      type: attachment._attributes.type,
      href: attachment._attributes.href,
      title: attachment._text,
    }));
  }

  return [{
    type: attachments.attachment._attributes.type,
    href: attachments.attachment._attributes.href,
    title: attachments.attachment._text,
  }];
};

const buildEvent = (event, isLive, roomName, day) => {
  if (!event) {
    return null;
  }

  const originalTitle = getText(event.title);
  const status = originalTitle
    ? getStatus(originalTitle.toLowerCase())
    : 'unknown';

  if (status === 'canceled') {
    return null;
  }

  const type = getType(event);
  const track = getText(event.track);
  const trackKey = track.toLowerCase().replace(/\s/g, '');

  if (type === 'other' && track === 'stand') {
    return null;
  }

  const title = getTitle(originalTitle, status);

  const persons = getPersons(event.persons);
  const links = getLinks(event.links);
  const attachments = getAttachments(event.attachments);

  const streams = [];
  const isLiveRoom =
    !roomName.startsWith('B.') &&
    !roomName.startsWith('I.') &&
    !roomName.startsWith('S.');
  const normalizedRoom = roomName.toLowerCase().replace(/\./g, '');
  if (isLiveRoom) {
    streams.push({
      href: constants.STREAM_LINK.replace('${ROOM_ID}', normalizedRoom),
      title: 'Stream',
      type: 'application/vnd.apple.mpegurl',
    });
  }

  const chat = /^[A-Z]\./.test(roomName)
    ? constants.CHAT_LINK.replace('${ROOM_ID}', roomName.substring(2))
    : null;

  return {
    day,
    isLive,
    status,
    type,
    track,
    trackKey,
    title,
    persons,
    links,
    attachments,
    streams,
    chat,
    room: roomName,
    url: event.url?._text,
    language: event.language?._text,
    feedbackUrl: event.feedback_url?._text,
    id: event._attributes.id,
    startTime: getText(event.start),
    duration: getText(event.duration),
    subtitle: getText(event.subtitle),
    abstract: getText(event.abstract),
    description: getText(event.description),
  };
};

export async function buildData({ year }: { year: string }) {
  const url = constants.SCHEDULE_LINK.replace('${YEAR}', year);
  const response = await fetch(url);
  const text = await response.text();
  const data = await parseData(text);

  const conferenceDates = data.day.map((day: Day) => day._attributes.date);
  const isLive = conferenceDates.includes(
    new Date().toISOString().substring(0, 10)
  );

  const types = {};
  const days = {};
  const rooms = {};
  const events = {};
  const tracks = {};

  const typeKeys = Object.keys(typeData);

  for (const type of typeKeys) {
    types[type] = {
      id: type,
      name: typeData[type].name,
      trackCount: 0,
      eventCount: 0,
      roomCount: 0,
      buildingCount: 0,
      rooms: new Set(),
      buildings: new Set()
    };
  }

  const buildingStats = Object.keys(buildings).reduce((acc, key) => {
    acc[key] = {
      ...buildings[key],
      roomCount: 0,
      trackCount: 0,
      eventCount: 0
    };
    return acc;
  }, {});

  for (const day of data.day) {
    const index = day._attributes.index;
    const date = day._attributes.date;
    const start = day._attributes.start;
    const end = day._attributes.end;

    days[index] = {
      date,
      start,
      end,
      id: index,
      name: `Day ${index}`,
      eventCount: 0,
      trackCount: 0,
      roomCount: 0,
      buildingCount: 0,
      rooms: new Set(),
      buildings: new Set(),
      tracks: new Set()
    };

    for (const room of day.room) {
      const roomName = getRoomName(room._attributes.name);
      const slug = room._attributes.slug || room._attributes.name;
      const roomKey = slug.substring(0, 1).toUpperCase();
      const building = buildings[roomKey];

      if (!rooms[slug]) {
        rooms[slug] = {
          name: roomName,
          slug,
          building,
          eventCount: 0
        };
        if (buildingStats[roomKey]) {
          buildingStats[roomKey].roomCount += 1;
        }
      }

      const roomEvents = Array.isArray(room.event) ? room.event : [room.event];

      for (const event of roomEvents) {
        const eventData = buildEvent(event, isLive, roomName, index);

        if (!eventData) {
          continue;
        }

        rooms[slug].eventCount += 1;
        
        if (buildingStats[roomKey]) {
          buildingStats[roomKey].eventCount += 1;
        }

        const type = eventData.type;
        if (!types[type]) {
          console.error(`Unknown type: ${type}`);
        }

        const trackKey = eventData.trackKey;
        if (!tracks[trackKey]) {
          tracks[trackKey] = {
            id: trackKey,
            name: eventData.track,
            type,
            room: roomName,
            day: [],
            eventCount: 0,
          };

          if (buildingStats[roomKey]) {
            buildingStats[roomKey].trackCount += 1;
          }

          types[type].trackCount += 1;
        }

        if (!tracks[trackKey].day.includes(index)) {
          tracks[trackKey].day.push(index);
        }

        events[eventData.id] = eventData;
        tracks[trackKey].eventCount += 1;

        if (types[type]) {
          types[type].eventCount++;
          types[type].rooms.add(roomName);
          types[type].roomCount = types[type].rooms.size;
          types[type].buildings.add(roomKey);
          types[type].buildingCount = types[type].buildings.size;
        }

        days[index].eventCount++;
        days[index].rooms.add(roomName);
        days[index].buildings.add(roomKey);
        days[index].tracks.add(trackKey);
        days[index].roomCount = days[index].rooms.size;
        days[index].buildingCount = days[index].buildings.size;
        days[index].trackCount = days[index].tracks.size;
      }
    }
  }

  const conference = {
    acronym: data.conference.acronym?._text,
    title: data.conference.title?._text,
    subtitle: data.conference.subtitle?._text,
    venue: data.conference.venue?._text,
    city: data.conference.city?._text,
    start: data.conference.start?._text,
    end: data.conference.end?._text,
    days: data.day.map((day) => day._attributes.date),
    day_change: data.conference.day_change?._text,
    timeslot_duration: data.conference.timeslot_duration?._text,
    time_zone_name: data.conference.time_zone_name?._text,
  };

  const result = {
    conference,
    types,
    buildings: buildingStats,
    days,
    rooms,
    tracks,
    events,
  };

  Object.values(types).forEach(type => {
    delete type.rooms;
    delete type.buildings;
  });

  Object.values(days).forEach(day => {
    delete day.rooms;
    delete day.buildings;
    delete day.tracks;
  });

  return result;
}
