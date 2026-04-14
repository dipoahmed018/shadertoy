#if !defined(VIEWER_GLSL_EMBED)
precision highp float;
precision highp int;
const vec3 iResolution = vec3(1.0, 1.0, 1.0);
const float iTime = 0.0;
const float iTimeDelta = 0.0;
const int iFrame = 0;
const vec4 iMouse = vec4(0.0);
const vec4 iDate = vec4(1970.0, 1.0, 1.0, 0.0);
const float iSampleRate = 48000.0;
layout(binding = 0) uniform sampler2D iChannel0;
layout(binding = 1) uniform sampler2D iChannel1;
layout(binding = 2) uniform sampler2D iChannel2;
layout(binding = 3) uniform sampler2D iChannel3;
const vec3 iChannelResolution[4] = vec3[4](
  vec3(1.0),
  vec3(1.0),
  vec3(1.0),
  vec3(1.0)
);

const float iChannelTime[4] = float[4](0.0, 0.0, 0.0, 0.0);
#endif

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy * 2.0 - 1.0;
  vec2 t = (uv + 1.0) * 0.5;
  vec3 base = mix(vec3(1.0), vec3(1.0, 0.0, 0.0), t.x);
  vec3 h = base * t.y;
  fragColor = vec4(h, 1.0);
}
