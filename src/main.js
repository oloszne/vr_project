import './style.css';
import * as THREE from "three";
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';

const SETTINGS = {
  physics: {
    gravity: -9.8,
    steps: 10,
    margin: 0.05,
    friction: 0.5,
    restitution: 0.9,
  },
  gameplay: {
    speed: 6, 
    minForce: 15,
    maxForce: 60,
    maxChargeTime: 1000, // ms to reach full power
    rayLength: 100,      // Max length when fully charged
    chargeColorStart: 0x0066ff, // Blue (Start)
    chargeColorEnd: 0xff0000    // Red (End)
  },
  world: {
    chunkSize: 100,
    chunksVisible: 5,
    chunkBufferBehind: 2,
    floorThickness: 1,
    floorRoughness: 0.8,
    floorY: -1,
    fogColor: 0x1a0b2e,
    fogDensity: 0.02,
    backgroundColor: 0x050505,
    gridDivisions: 20,
    gridColor1: 0xff00cc, // Grid remains Pink/Magenta style
    gridColor2: 0x444444
  },
  camera: {
    fov: 75,
    near: 0.1,
    far: 1000,
    startZ: 5
  },
  lighting: {
    ambientSky: 0xffffff,
    ambientGround: 0x444444,
    ambientIntensity: 0.6,
    dirColor: 0xffffff,
    dirIntensity: 1,
    dirOffset: { x: 10, y: 20, z: 10 },
    shadowSize: 50
  },
  projectile: {
    radius: 0.2,
    mass: 5,
    segments: 32,
    color: 0x00ffcc,
    emissive: 0x004433,
    roughness: 0.1,
    metalness: 0.5
  }
};

let scene, camera, renderer;
let userRig; 
let controller1, controller2;
let controllerGrip1, controllerGrip2;

const clock = new THREE.Clock();

// Physics
let physicsWorld;
let collisionConfiguration;
let dispatcher;
let broadphase;
let solver;
const rigidBodies = [];
let transformAux1;

// Chunks
const activeChunks = [];
let lastChunkIndex = 0;

// Lighting
let dirLight;

// State
const chargeMap = new Map(); 

// Color Helpers (Pre-allocated for performance)
const colorStart = new THREE.Color(SETTINGS.gameplay.chargeColorStart);
const colorEnd = new THREE.Color(SETTINGS.gameplay.chargeColorEnd);

Ammo().then(start);

function start() {
  initGraphics();
  initVRControllers();
  initPhysics();
  initChunks();
  
  renderer.setAnimationLoop(render);
}

function initGraphics() {
  const container = document.createElement('div');
  document.body.appendChild(container);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(SETTINGS.world.fogColor);
  scene.fog = new THREE.FogExp2(SETTINGS.world.fogColor, SETTINGS.world.fogDensity);

  camera = new THREE.PerspectiveCamera(
    SETTINGS.camera.fov,
    window.innerWidth / window.innerHeight,
    SETTINGS.camera.near,
    SETTINGS.camera.far
  );

  // User Rig Group
  userRig = new THREE.Group();
  userRig.position.set(0, 0, SETTINGS.camera.startZ);
  userRig.add(camera);
  scene.add(userRig);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  document.body.appendChild(VRButton.createButton(renderer));

  // Lighting
  const ambientLight = new THREE.HemisphereLight(
    SETTINGS.lighting.ambientSky, 
    SETTINGS.lighting.ambientGround, 
    SETTINGS.lighting.ambientIntensity
  );
  scene.add(ambientLight);

  dirLight = new THREE.DirectionalLight(SETTINGS.lighting.dirColor, SETTINGS.lighting.dirIntensity);
  dirLight.castShadow = true;
  dirLight.shadow.camera.top = SETTINGS.lighting.shadowSize;
  dirLight.shadow.camera.bottom = -SETTINGS.lighting.shadowSize;
  dirLight.shadow.camera.left = -SETTINGS.lighting.shadowSize;
  dirLight.shadow.camera.right = SETTINGS.lighting.shadowSize;
  dirLight.shadow.mapSize.width = 2048;
  dirLight.shadow.mapSize.height = 2048;
  scene.add(dirLight);

  window.addEventListener("resize", onWindowResize);
}

function initVRControllers() {
  // 1. Controller Rays & Events
  controller1 = renderer.xr.getController(0);
  controller1.addEventListener('selectstart', onSelectStart);
  controller1.addEventListener('selectend', onSelectEnd);
  userRig.add(controller1);

  controller2 = renderer.xr.getController(1);
  controller2.addEventListener('selectstart', onSelectStart);
  controller2.addEventListener('selectend', onSelectEnd);
  userRig.add(controller2);

  // Helper to create the visual ray
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 0, -SETTINGS.gameplay.rayLength)
  ]);
  
  // Start with "Lowest Blue" color
  const material = new THREE.LineBasicMaterial({ color: colorStart });
  
  const line1 = new THREE.Line(geometry, material.clone()); 
  line1.name = 'ray';
  line1.scale.z = 0; // Invisible/Short by default
  controller1.add(line1);

  const line2 = new THREE.Line(geometry, material.clone());
  line2.name = 'ray';
  line2.scale.z = 0; // Invisible/Short by default
  controller2.add(line2);

  // 2. Controller Models
  const controllerModelFactory = new XRControllerModelFactory();

  controllerGrip1 = renderer.xr.getControllerGrip(0);
  controllerGrip1.add(controllerModelFactory.createControllerModel(controllerGrip1));
  userRig.add(controllerGrip1);

  controllerGrip2 = renderer.xr.getControllerGrip(1);
  controllerGrip2.add(controllerModelFactory.createControllerModel(controllerGrip2));
  userRig.add(controllerGrip2);
}

function onSelectStart(event) {
  const controller = event.target;
  // Start tracking charge time
  chargeMap.set(controller, Date.now());
}

function onSelectEnd(event) {
  const controller = event.target;
  
  if (chargeMap.has(controller)) {
    const startTime = chargeMap.get(controller);
    const holdTime = Date.now() - startTime;
    const power = Math.min(holdTime / SETTINGS.gameplay.maxChargeTime, 1.0);
    
    fireProjectile(controller, power);
    
    // Stop tracking
    chargeMap.delete(controller);
    
    // Reset visual immediately
    const ray = controller.getObjectByName('ray');
    if(ray) {
        ray.material.color.copy(colorStart); // Reset to Blue
        ray.scale.z = 0; // Reset to invisible
    }
  }
}

function initPhysics() {
  collisionConfiguration = new Ammo.btDefaultCollisionConfiguration();
  dispatcher = new Ammo.btCollisionDispatcher(collisionConfiguration);
  broadphase = new Ammo.btDbvtBroadphase();
  solver = new Ammo.btSequentialImpulseConstraintSolver();

  physicsWorld = new Ammo.btDiscreteDynamicsWorld(
    dispatcher,
    broadphase,
    solver,
    collisionConfiguration
  );

  physicsWorld.setGravity(new Ammo.btVector3(0, SETTINGS.physics.gravity, 0));
  transformAux1 = new Ammo.btTransform();
}

// ------------------------------------------------------------------
// CHUNK SYSTEM
// ------------------------------------------------------------------

class Chunk {
  constructor(zIndex) {
    this.zIndex = zIndex;
    this.zPos = zIndex * -SETTINGS.world.chunkSize;
    
    // Visuals
    const planeGeometry = new THREE.PlaneGeometry(
      SETTINGS.world.chunkSize,
      SETTINGS.world.chunkSize
    );
    const planeMaterial = new THREE.MeshStandardMaterial({
      color: SETTINGS.world.backgroundColor,
      roughness: SETTINGS.world.floorRoughness
    });
    
    this.mesh = new THREE.Mesh(planeGeometry, planeMaterial);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.set(0, SETTINGS.world.floorY, this.zPos);
    this.mesh.receiveShadow = true;
    scene.add(this.mesh);

    this.grid = new THREE.GridHelper(
      SETTINGS.world.chunkSize,
      SETTINGS.world.gridDivisions,
      SETTINGS.world.gridColor1,
      SETTINGS.world.gridColor2
    );
    this.grid.position.set(0, SETTINGS.world.floorY + 0.01, this.zPos);
    scene.add(this.grid);

    // Physics
    const shape = new Ammo.btBoxShape(
      new Ammo.btVector3(SETTINGS.world.chunkSize / 2, SETTINGS.world.floorThickness, SETTINGS.world.chunkSize / 2)
    );
    shape.setMargin(SETTINGS.physics.margin);

    const transform = new Ammo.btTransform();
    transform.setIdentity();
    transform.setOrigin(new Ammo.btVector3(0, SETTINGS.world.floorY, this.zPos));

    const motionState = new Ammo.btDefaultMotionState(transform);
    const localInertia = new Ammo.btVector3(0, 0, 0);

    const rbInfo = new Ammo.btRigidBodyConstructionInfo(0, motionState, shape, localInertia);
    this.body = new Ammo.btRigidBody(rbInfo);
    this.body.setRestitution(SETTINGS.physics.restitution);
    this.body.setFriction(SETTINGS.physics.friction);

    physicsWorld.addRigidBody(this.body);
  }

  dispose() {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    scene.remove(this.grid);
    this.grid.dispose();
    physicsWorld.removeRigidBody(this.body);
    Ammo.destroy(this.body);
  }
}

function initChunks() {
  for (let i = -SETTINGS.world.chunkBufferBehind; i < SETTINGS.world.chunksVisible; i++) {
    activeChunks.push(new Chunk(i));
  }
}

function updateChunks() {
  const currentChunkIndex = Math.floor(-userRig.position.z / SETTINGS.world.chunkSize);

  if (currentChunkIndex > lastChunkIndex) {
    const nextSpawnIndex = currentChunkIndex + SETTINGS.world.chunksVisible - 1;
    const exists = activeChunks.some(c => c.zIndex === nextSpawnIndex);
    if(!exists) {
       activeChunks.push(new Chunk(nextSpawnIndex));
    }

    const cleanupThreshold = currentChunkIndex - SETTINGS.world.chunkBufferBehind;
    for (let i = activeChunks.length - 1; i >= 0; i--) {
      if (activeChunks[i].zIndex < cleanupThreshold) {
        activeChunks[i].dispose();
        activeChunks.splice(i, 1);
      }
    }
    lastChunkIndex = currentChunkIndex;
  }
}

// ------------------------------------------------------------------

function fireProjectile(controller, power) {
  const startPos = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  controller.getWorldPosition(startPos);
  controller.getWorldQuaternion(quaternion);

  const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();

  // Mesh size scales with power
  const radius = SETTINGS.projectile.radius * (0.5 + (power * 0.5)); 
  
  const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, SETTINGS.projectile.segments, SETTINGS.projectile.segments),
    new THREE.MeshStandardMaterial({
      color: SETTINGS.projectile.color,
      emissive: SETTINGS.projectile.emissive,
      roughness: SETTINGS.projectile.roughness,
      metalness: SETTINGS.projectile.metalness
    })
  );
  ballMesh.position.copy(startPos);
  ballMesh.castShadow = true;
  scene.add(ballMesh);

  // Physics
  const shape = new Ammo.btSphereShape(radius);
  shape.setMargin(SETTINGS.physics.margin);

  const transform = new Ammo.btTransform();
  transform.setIdentity();
  transform.setOrigin(new Ammo.btVector3(startPos.x, startPos.y, startPos.z));

  const motionState = new Ammo.btDefaultMotionState(transform);
  const localInertia = new Ammo.btVector3(0, 0, 0);
  shape.calculateLocalInertia(SETTINGS.projectile.mass, localInertia);

  const rbInfo = new Ammo.btRigidBodyConstructionInfo(
    SETTINGS.projectile.mass,
    motionState,
    shape,
    localInertia
  );
  const body = new Ammo.btRigidBody(rbInfo);
  body.setRestitution(SETTINGS.physics.restitution);
  body.setFriction(SETTINGS.physics.friction);

  const forceMagnitude = SETTINGS.gameplay.minForce + (SETTINGS.gameplay.maxForce - SETTINGS.gameplay.minForce) * power;
  
  const velocity = direction.multiplyScalar(forceMagnitude);
  velocity.z -= SETTINGS.gameplay.speed; 

  body.setLinearVelocity(new Ammo.btVector3(velocity.x, velocity.y, velocity.z));

  ballMesh.userData.physicsBody = body;
  rigidBodies.push(ballMesh);
  physicsWorld.addRigidBody(body);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function render() {
  const deltaTime = clock.getDelta();
  const now = Date.now();
  
  // 1. Handle Charging Visuals
  chargeMap.forEach((startTime, controller) => {
      const ray = controller.getObjectByName('ray');
      if (ray) {
          const holdTime = now - startTime;
          // Calculate 0.0 to 1.0 progress
          const percent = Math.min(holdTime / SETTINGS.gameplay.maxChargeTime, 1.0);
          
          // Lerp the color (Blue -> Red)
          ray.material.color.lerpColors(colorStart, colorEnd, percent);
          
          // Grow the ray length (0 -> 100%)
          // We set scale.z because the geometry is defined locally
          ray.scale.z = percent; 
      }
  });

  // 2. Move User Rig
  userRig.position.z -= SETTINGS.gameplay.speed * deltaTime;

  // 3. Move Light
  if (dirLight) {
      dirLight.position.set(
          userRig.position.x + SETTINGS.lighting.dirOffset.x,
          userRig.position.y + SETTINGS.lighting.dirOffset.y,
          userRig.position.z + SETTINGS.lighting.dirOffset.z
      );
      dirLight.target.position.copy(userRig.position);
      dirLight.target.updateMatrixWorld();
  }

  updateChunks();
  updatePhysics(deltaTime);

  renderer.render(scene, camera);
}

function updatePhysics(deltaTime) {
  if (!physicsWorld) return;
  physicsWorld.stepSimulation(deltaTime, SETTINGS.physics.steps);

  const cleanupZBehind = userRig.position.z + 50; 
  const cleanupZFar = userRig.position.z - 300;

  for (let i = rigidBodies.length - 1; i >= 0; i--) {
    const objThree = rigidBodies[i];
    const objPhys = objThree.userData.physicsBody;
    const ms = objPhys.getMotionState();

    if (ms) {
      ms.getWorldTransform(transformAux1);
      const p = transformAux1.getOrigin();
      const q = transformAux1.getRotation();

      objThree.position.set(p.x(), p.y(), p.z());
      objThree.quaternion.set(q.x(), q.y(), q.z(), q.w());

      if (p.y() < -10 || p.z() > cleanupZBehind || p.z() < cleanupZFar) {
        scene.remove(objThree);
        if (objThree.geometry) objThree.geometry.dispose();
        if (objThree.material) objThree.material.dispose();
        physicsWorld.removeRigidBody(objPhys);
        rigidBodies.splice(i, 1);
      }
    }
  }
}