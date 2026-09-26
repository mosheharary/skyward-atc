// Sea / bay surface at sea level: Water.js planar reflections at high quality, PBR water otherwise.
import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';

export type WaterMode = 'pbr' | 'mirror';

export class WaterSystem {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private water: Water | null = null;
  private pbr: THREE.MeshStandardMaterial | null = null;
  private readonly pbrUniforms = { wTime: { value: 0 } };
  private readonly geometry: THREE.PlaneGeometry;
  private readonly normals: THREE.Texture;
  private readonly color: THREE.Color;
  private readonly seaY: number;
  /** Objects hidden while the mirror renders (cheap reflections). */
  readonly hideInReflection: THREE.Object3D[] = [];

  constructor(seaY: number, color: THREE.Color, normals: THREE.Texture, size: number) {
    this.group.name = 'Water';
    this.seaY = seaY;
    this.color = color.clone();
    this.normals = normals;
    this.geometry = new THREE.PlaneGeometry(size, size, 1, 1);
  }

  setMode(mode: WaterMode, mirrorSize: number): void {
    this.disposeMesh();
    if (mode === 'mirror') {
      const w = new Water(this.geometry, {
        textureWidth: mirrorSize,
        textureHeight: mirrorSize,
        waterNormals: this.normals,
        sunDirection: new THREE.Vector3(0.7, 0.7, 0),
        sunColor: 0xffffff,
        // Water.js only uses this as sub-surface scatter; the linear palette colour alone reads as black ink.
        waterColor: this.color.clone().multiplyScalar(2.6),
        distortionScale: 2.6,
        fog: true,
        alpha: 1,
      });
      w.material.uniforms.size.value = 0.6;
      // Stock Water.js gives the sea a strong diffuse term that turns into grey static on the wave normals
      // when seen from altitude; real water is almost purely reflective + deep scatter.
      w.material.fragmentShader = w.material.fragmentShader.replace('sunColor * diffuseLight * 0.3', 'sunColor * diffuseLight * 0.015');
      w.rotation.x = -Math.PI / 2;
      w.position.y = this.seaY;
      w.renderOrder = -10;
      const original = w.onBeforeRender.bind(w);
      w.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
        const vis = this.hideInReflection.map((o) => o.visible);
        this.hideInReflection.forEach((o) => (o.visible = false));
        original(renderer, scene, camera, geometry, material, group);
        this.hideInReflection.forEach((o, i) => (o.visible = vis[i]));
      };
      w.receiveShadow = false;
      this.water = w;
      this.mesh = w;
    } else {
      const nm = this.normals.clone();
      nm.wrapS = nm.wrapT = THREE.RepeatWrapping;
      nm.needsUpdate = true;
      const mat = new THREE.MeshStandardMaterial({
        color: this.color,
        roughness: 0.06,
        metalness: 0.0,
        normalMap: nm,
        normalScale: new THREE.Vector2(0.45, 0.45),
        envMapIntensity: 1.2,
      });
      const uniforms = this.pbrUniforms;
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec2 vWaterUv;')
          .replace(
            '#include <fog_vertex>',
            '#include <fog_vertex>\n{ vec4 wwp = modelMatrix * vec4( transformed, 1.0 ); vWaterUv = vec2( wwp.x, -wwp.z ) / 90.0; }',
          );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform float wTime;\nvarying vec2 vWaterUv;')
          .replace(
            '#include <normal_fragment_maps>',
            /* glsl */ `
            {
              vec2 uvA = vWaterUv + vec2( wTime * 0.0021, wTime * 0.0013 );
              vec2 uvB = vWaterUv * 2.7 - vec2( wTime * 0.0034, -wTime * 0.0027 );
              vec2 uvC = vWaterUv * 0.23 + vec2( -wTime * 0.0006, wTime * 0.0009 );
              vec3 nA = texture2D( normalMap, uvA ).xyz * 2.0 - 1.0;
              vec3 nB = texture2D( normalMap, uvB ).xyz * 2.0 - 1.0;
              vec3 nC = texture2D( normalMap, uvC ).xyz * 2.0 - 1.0;
              vec3 mapN = normalize( vec3( ( nA.xy + nB.xy * 0.6 + nC.xy * 0.8 ) * normalScale, 1.0 ) );
              normal = normalize( tbn * mapN );
            }`,
          );
      };
      mat.customProgramCacheKey = () => 'skyward-water-pbr-v1';
      const m = new THREE.Mesh(this.geometry, mat);
      m.rotation.x = -Math.PI / 2;
      m.position.y = this.seaY;
      m.renderOrder = -10;
      m.receiveShadow = false;
      this.pbr = mat;
      this.mesh = m;
    }
    this.mesh.name = 'WaterSurface';
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  update(time: number, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, camera: THREE.Camera, wind: number): void {
    if (this.mesh) this.mesh.position.set(camera.position.x, this.seaY, camera.position.z);
    if (this.water) {
      const u = this.water.material.uniforms;
      u.time.value = time * (0.35 + Math.min(1.2, wind / 18));
      (u.sunDirection.value as THREE.Vector3).copy(sunDir).normalize();
      (u.sunColor.value as THREE.Color).copy(sunColor).multiplyScalar(Math.max(0, sunIntensity) * 0.35);
      u.distortionScale.value = 1.6 + Math.min(4, wind / 6);
      // Stretch the wave noise with altitude so it doesn't alias into grain when seen from the approach.
      const agl = Math.max(0, camera.position.y - this.seaY);
      u.size.value = 0.6 / (1 + agl / 350);
    }
    if (this.pbr) {
      this.pbrUniforms.wTime.value = time * (0.6 + Math.min(1.5, wind / 12));
    }
  }

  private disposeMesh(): void {
    if (this.mesh) {
      this.group.remove(this.mesh);
      if (this.water) {
        const w = this.water as unknown as { material: THREE.ShaderMaterial };
        (w.material.uniforms.mirrorSampler.value as THREE.Texture | null)?.dispose();
        w.material.dispose();
      }
      if (this.pbr) {
        this.pbr.normalMap?.dispose();
        this.pbr.dispose();
      }
    }
    this.mesh = null;
    this.water = null;
    this.pbr = null;
  }

  dispose(): void {
    this.disposeMesh();
    this.geometry.dispose();
  }
}
