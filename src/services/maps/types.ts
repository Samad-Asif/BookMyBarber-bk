export type PlacePrediction = {
  placeId: string;
  mainText: string;
  secondaryText: string;
  description: string;
};

export type PlaceDetails = {
  placeId: string;
  name: string | null;
  formattedAddress: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  website: string | null;
  googleMapsUrl: string | null;
  rating: number | null;
  userRatingsTotal: number | null;
};

export type GeocodeResult = {
  formattedAddress: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
};

export type RoutePath = {
  distanceMeters: number;
  durationSeconds: number;
  points: Array<{ latitude: number; longitude: number }>;
};
