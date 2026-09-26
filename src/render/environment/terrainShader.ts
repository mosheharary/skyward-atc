// GLSL injected into MeshStandardMaterial for the procedural terrain surface.

export const terrainVertexPars = /* glsl */ `
attribute vec4 aSurf0;
attribute vec4 aSurf1;
varying vec4 vTSurf0;
varying vec4 vTSurf1;
varying vec3 vTWorld;
varying vec3 vTNormal;
`;

export const terrainVertexMain = /* glsl */ `
vTSurf0 = aSurf0;
vTSurf1 = aSurf1;
vTWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vTNormal = normalize( mat3( modelMatrix ) * objectNormal );
`;

export const terrainFragmentPars = /* glsl */ `
uniform sampler2D tDetail;
uniform sampler2D tMacro;
uniform vec3 tGrass;
uniform vec3 tGrassDry;
uniform vec3 tSoil;
uniform vec3 tRock;
uniform vec3 tSand;
uniform vec3 tForest;
uniform vec3 tUrban;
uniform vec3 tAirA;
uniform vec3 tAirB;
uniform vec3 tHedge;
uniform vec3 tCrops[ 8 ];
uniform float tCropCount;
uniform float tDryness;
uniform float tFarmAngle;
uniform vec2 tMowDir;
uniform float tWetness;
uniform float tNight;
uniform vec4 tCities[ 4 ];
uniform float tCityCount;
uniform float tBlock;
uniform float tStreet;
uniform vec3 tStreetGlow;
varying vec4 vTSurf0;
varying vec4 vTSurf1;
varying vec3 vTWorld;
varying vec3 vTNormal;

float tHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}

vec3 tCropColor( float h ) {
  int idx = int( min( floor( h * tCropCount ), tCropCount - 1.0 ) );
  return tCrops[ idx ];
}

vec3 tFarmland( vec2 p, float dist, out float edge ) {
  float ca = cos( tFarmAngle ), sa = sin( tFarmAngle );
  vec2 q = vec2( ca * p.x - sa * p.y, sa * p.x + ca * p.y );
  float rowH = 430.0;
  float row = floor( q.y / rowH );
  float rowJ = tHash( vec2( row, 7.31 ) );
  float colW = 240.0 + 330.0 * rowJ;
  float qx = q.x + row * 97.0;
  float col = floor( qx / colW );
  vec2 cellId = vec2( col, row );
  vec2 f = vec2( fract( qx / colW ), fract( q.y / rowH ) );
  float hs = tHash( cellId + 3.1 );
  float strips = 1.0 + floor( hs * 3.0 );
  float s = floor( f.x * strips );
  float fx = fract( f.x * strips );
  vec2 fieldId = cellId * 4.0 + vec2( s, 0.0 );
  float hf = tHash( fieldId + 11.7 );
  vec3 crop = tCropColor( hf );
  crop *= 0.9 + 0.2 * tHash( fieldId + 2.3 );
  // furrows / crop rows
  float alongY = tHash( fieldId + 5.1 ) > 0.5 ? 1.0 : 0.0;
  float along = mix( qx, q.y, alongY ) / 4.2;
  float furrowAA = clamp( 1.0 - fwidth( along ) * 1.8, 0.0, 1.0 );
  crop *= 1.0 + sin( along * 6.2831853 ) * 0.07 * furrowAA;
  // field borders (hedgerows / tracks)
  float ex = min( fx, 1.0 - fx ) * colW / strips;
  float ey = min( f.y, 1.0 - f.y ) * rowH;
  float e = min( ex, ey );
  float aa = fwidth( e ) + 0.001;
  edge = 1.0 - smoothstep( 2.5 - aa, 2.5 + aa, e );
  edge *= clamp( 1.0 - aa * 0.25, 0.0, 1.0 );
  return crop;
}

float tStreetMask( vec2 p ) {
  float best = 1e9;
  vec4 cc = tCities[ 0 ];
  for ( int i = 0; i < 4; i ++ ) {
    if ( float( i ) >= tCityCount ) break;
    vec4 c = tCities[ i ];
    float d = length( p - c.xy ) / max( c.z, 1.0 );
    if ( d < best ) { best = d; cc = c; }
  }
  float ca = cos( cc.w ), sa = sin( cc.w );
  vec2 r = p - cc.xy;
  vec2 q = vec2( ca * r.x - sa * r.y, sa * r.x + ca * r.y );
  vec2 f = abs( fract( q / tBlock + 0.5 ) - 0.5 ) * tBlock;
  float e = min( f.x, f.y );
  float aa = fwidth( e ) + 0.001;
  float m = 1.0 - smoothstep( tStreet * 0.5 - aa, tStreet * 0.5 + aa, e );
  return m * clamp( 1.0 - aa * 0.08, 0.0, 1.0 );
}

vec3 terrainAlbedo( out float rough, out vec3 emissive ) {
  vec2 p = vTWorld.xz;
  float dist = length( vTWorld - cameraPosition );
  vec4 m1 = texture2D( tMacro, p * ( 1.0 / 11000.0 ) );
  vec4 m2 = texture2D( tMacro, p * ( 1.0 / 2900.0 ) + 0.37 );
  vec4 m3 = texture2D( tMacro, p * ( 1.0 / 640.0 ) + 0.71 );
  float fine = 1.0 - smoothstep( 120.0, 700.0, dist );
  float mid = 1.0 - smoothstep( 900.0, 6000.0, dist );
  vec4 d1 = texture2D( tDetail, p * ( 1.0 / 6.5 ) );
  vec4 d2 = texture2D( tDetail, p * ( 1.0 / 37.0 ) + 0.5 );
  vec4 det = 1.0 + ( d1 - 0.5 ) * 0.9 * fine + ( d2 - 0.5 ) * 0.7 * mid;

  float dryN = m1.g * 0.55 + m2.r * 0.45;
  float dry = smoothstep( 0.62 - tDryness * 0.45, 0.8 - tDryness * 0.45, dryN );
  vec3 grass = mix( tGrass, tGrassDry, dry );
  grass *= 0.86 + 0.28 * m3.g;
  grass = mix( grass, tSoil, smoothstep( 0.78, 0.95, m3.b ) * 0.35 );
  vec3 col = grass * det.r;
  rough = 0.95;
  emissive = vec3( 0.0 );

  float br = ( m3.a - 0.5 ) * 0.35 + ( d2.g - 0.5 ) * 0.15;
  float wFarm = smoothstep( 0.3, 0.7, vTSurf0.y + br );
  float wForest = smoothstep( 0.3, 0.7, vTSurf0.z + br );
  float wUrban = smoothstep( 0.35, 0.65, vTSurf0.w + br * 0.6 );
  float wAir = smoothstep( 0.15, 0.85, vTSurf0.x );
  float wSand = smoothstep( 0.3, 0.7, vTSurf1.x + br * 0.5 );
  float slope = 1.0 - clamp( vTNormal.y, 0.0, 1.0 );
  float wRock = clamp( smoothstep( 0.3, 0.7, vTSurf1.y + br ) + smoothstep( 0.22, 0.42, slope + br * 0.2 ), 0.0, 1.0 );

  if ( wFarm > 0.001 ) {
    float edge;
    vec3 farm = tFarmland( p, dist, edge ) * det.g;
    farm = mix( farm, tHedge * det.r, edge * 0.85 );
    col = mix( col, farm, wFarm );
  }
  col = mix( col, tForest * det.r * ( 0.85 + 0.3 * m3.r ), wForest );
  float street = 0.0;
  if ( wUrban > 0.001 ) {
    street = tStreetMask( p );
    vec3 urb = tUrban * ( 0.8 + 0.4 * m3.r ) * det.g;
    urb = mix( urb, vec3( 0.045, 0.045, 0.05 ), street * 0.85 );
    col = mix( col, urb, wUrban );
    rough = mix( rough, 0.8, wUrban );
  }
  col = mix( col, tRock * det.b * ( 0.85 + 0.3 * m2.b ), wRock );
  rough = mix( rough, 0.85, wRock );
  vec3 sand = tSand * det.a;
  sand = mix( sand, sand * 0.6, vTSurf1.z );
  col = mix( col, sand, wSand );
  if ( wAir > 0.001 ) {
    float mow = dot( p, tMowDir ) / 16.0;
    float stripe = 0.5 + 0.5 * sin( mow * 6.2831853 );
    float saa = clamp( 1.0 - fwidth( mow ) * 1.5, 0.0, 1.0 );
    // Subtle mowing bands broken up by larger worn/lush patches, so the field doesn't read as a carpet.
    vec3 air = mix( tAirA, tAirB, 0.5 + ( stripe - 0.5 ) * saa * 0.35 );
    air = mix( air, tAirB * vec3( 1.08, 1.0, 0.8 ), smoothstep( 0.55, 0.85, m3.b ) * 0.45 );
    air *= ( 0.86 + 0.28 * m3.g ) * det.r;
    col = mix( col, air, wAir );
    rough = mix( rough, 0.93, wAir );
  }
  float wet = tWetness * ( 1.0 - wSand * 0.4 );
  col *= mix( 1.0, 0.6, wet );
  rough = mix( rough, 0.42, wet );
  emissive = tStreetGlow * street * wUrban * tNight;
  return col;
}
`;
