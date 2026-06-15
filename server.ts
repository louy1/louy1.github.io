import express from 'express';
import path from 'path';
import fs from 'fs';
import http from 'http';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { DBState, Student, Section, Question, Progress, Achievement, StudentAchievement, Ad, News, UISetting } from './src/types';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';

const app = express();
const PORT = 3000;

// Health check endpoint for keep-warm pinging
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Path to data file
const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_FILE = path.join(process.cwd(), 'db_permanent_backup.json');

// Initialize Firebase configuration for cloud data persistence
const firebaseConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf-8'));
const firebaseApp = initializeApp(firebaseConfig);
const firestoreDb = getFirestore(firebaseApp, firebaseConfig.firestoreDatabaseId);

// Shared database variable cached in-memory for sub-millisecond local reads and active synchronization
let dbInstance: DBState | null = null;

// Firestore error diagnostic handling
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: null,
      email: null,
      emailVerified: null,
      isAnonymous: null,
      tenantId: null,
      providerInfo: []
    }
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Ensure database directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Restore from permanent backup on start if running file is missing
if (!fs.existsSync(DATA_FILE) && fs.existsSync(BACKUP_FILE)) {
  console.log('🔄 استعادة قواعد البيانات من النسخة الاحتياطية الدائمة للجذر...');
  try {
    fs.copyFileSync(BACKUP_FILE, DATA_FILE);
  } catch (err) {
    console.error('Failed to copy permanent backup to data folder', err);
  }
}

// Initialize Gemini API client
// Always use process.env.GEMINI_API_KEY
const geminiApiKey = process.env.GEMINI_API_KEY;
let ai: GoogleGenAI | null = null;
if (geminiApiKey) {
  ai = new GoogleGenAI({
    apiKey: geminiApiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

// Ensure database directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Setup Seed Data
const DEFAULT_SECTONS: Section[] = [
  { id: 'math', slug: 'math', title: 'الرياضيات', icon: 'Calculator', color: 'blue', sort: 1, is_custom: false },
  { id: 'earth', slug: 'earth', title: 'علم الأرض', icon: 'Globe', color: 'green', sort: 2, is_custom: false },
  { id: 'english', slug: 'english', title: 'الإنجليزي', icon: 'BookOpen', color: 'purple', sort: 3, is_custom: false },
  { id: 'physics', slug: 'physics', title: 'الفيزياء', icon: 'Zap', color: 'orange', sort: 4, is_custom: false }
];

const DEFAULT_QUESTIONS: Question[] = [
  // Math Quiz
  {
    id: 'math-q1',
    section_id: 'math',
    raw_text: "1. ما هو ناتج 5 + 7؟\nأ. 10\nب. 12\nج. 14\nب# *+5 *-1",
    parsed_json: {
      questionText: "ما هو ناتج 5 + 7؟",
      options: [
        { key: "أ", text: "10" },
        { key: "ب", text: "12" },
        { key: "ج", text: "14" }
      ],
      correctAnswer: "ب"
    },
    points_correct: 5,
    points_wrong: 1,
    sort: 1
  },
  {
    id: 'math-q2',
    section_id: 'math',
    raw_text: "2. ما هو الجذر التربيعي للعدد 16؟\nأ. 2\nب. 4\nج. 8\nب# *+5 *-1",
    parsed_json: {
      questionText: "ما هو الجذر التربيعي للعدد 16؟",
      options: [
        { key: "أ", text: "2" },
        { key: "ب", text: "4" },
        { key: "ج", text: "8" }
      ],
      correctAnswer: "ب"
    },
    points_correct: 5,
    points_wrong: 1,
    sort: 2
  },
  {
    id: 'math-q3',
    section_id: 'math',
    raw_text: "3. ناتج حل المعادلة: 2س - 4 = 10\nأ. س = 5\nب. س = 7\nج. س = 14\nب# *+6 *-2",
    parsed_json: {
      questionText: "ناتج حل المعادلة: 2س - 4 = 10",
      options: [
        { key: "أ", text: "س = 5" },
        { key: "ب", text: "س = 7" },
        { key: "ج", text: "س = 14" }
      ],
      correctAnswer: "ب"
    },
    points_correct: 6,
    points_wrong: 2,
    sort: 3
  },
  // Earth Quiz
  {
    id: 'earth-q1',
    section_id: 'earth',
    raw_text: "1. أي الكواكب هو الأقرب إلى الشمس في المجموعة الشمسية؟\nأ. المشتري\nب. عطارد\nج. الزهرة\nب# *+5 *-2",
    parsed_json: {
      questionText: "أي الكواكب هو الأقرب إلى الشمس في المجموعة الشمسية؟",
      options: [
        { key: "أ", text: "المشتري" },
        { key: "ب", text: "عطارد" },
        { key: "ج", text: "الزهرة" }
      ],
      correctAnswer: "ب"
    },
    points_correct: 5,
    points_wrong: 2,
    sort: 1
  },
  {
    id: 'earth-q2',
    section_id: 'earth',
    raw_text: "2. ما هي أعلى قمة جبلية على سطح الكرة الأرضية؟\nأ. جبل إفرست\nب. جبل كيليمانجارو\nج. جبل كليمنجارو\nأ# *+5 *-1",
    parsed_json: {
      questionText: "ما هي أعلى قمة جبلية على سطح الكرة الأرضية؟",
      options: [
        { key: "أ", text: "جبل إفرست" },
        { key: "ب", text: "جبل كيليمانجارو" },
        { key: "ج", text: "جبل كليمنجارو" }
      ],
      correctAnswer: "أ"
    },
    points_correct: 5,
    points_wrong: 1,
    sort: 2
  },
  // English Quiz
  {
    id: 'english-q1',
    section_id: 'english',
    raw_text: "1. Which of the following is a noun?\nأ. run\nب. happy\nج. happiness\nج# *+5 *-0",
    parsed_json: {
      questionText: "Which of the following is a noun?",
      options: [
        { key: "أ", text: "run" },
        { key: "ب", text: "happy" },
        { key: "ج", text: "happiness" }
      ],
      correctAnswer: "ج"
    },
    points_correct: 5,
    points_wrong: 0,
    sort: 1
  },
  // Physics Quiz
  {
    id: 'physics-q1',
    section_id: 'physics',
    raw_text: "1. ما هو قانون نيوتن الأول للسرعة والحركة؟\nأ. الجسم الساكن يبقى ساكناً ما لم تؤثر عليه قوة خارجية\nب. القوة تساوي الكتلة في التسارع\nج. لكل فعل رد فعل مساوٍ له في المقدار ومضاد له في الاتجاه\nأ# *+5 *-1",
    parsed_json: {
      questionText: "ما هو قانون نيوتن الأول للسرعة والحركة؟",
      options: [
        { key: "أ", text: "الجسم الساكن يبقى ساكناً ما لم تؤثر عليه قوة خارجية" },
        { key: "ب", text: "القوة تساوي الكتلة في التسارع" },
        { key: "ج", text: "لكل فعل رد فعل مساوٍ له في المقدار ومضاد له في الاتجاه" }
      ],
      correctAnswer: "أ"
    },
    points_correct: 5,
    points_wrong: 1,
    sort: 1
  }
];

const DEFAULT_ACHIEVEMENTS: Achievement[] = [
  { id: 'ach1', title: 'البداية السريعة', condition_json: { type: 'answered_count', value: 1 }, xp_reward: 50, icon: 'Award', is_daily: false },
  { id: 'ach2', title: 'خبير الرياضيات', condition_json: { type: 'section_xp', value: 10, section_id: 'math' }, xp_reward: 100, icon: 'Cpu', is_daily: false },
  { id: 'ach3', title: 'المستكشف الذكي', condition_json: { type: 'total_xp', value: 20 }, xp_reward: 150, icon: 'Compass', is_daily: false },
  { id: 'ach4', title: 'طالب مجتهد (يومي)', condition_json: { type: 'correct_count', value: 3 }, xp_reward: 200, icon: 'Flame', is_daily: true },
  { id: 'ach_math_pro', title: 'تاج فيثاغورس الذهبي', condition_json: { type: 'section_xp', value: 25, section_id: 'math' }, xp_reward: 250, icon: 'Brain', is_daily: false },
  { id: 'ach_earth_pro', title: 'وسام فلكي الجيل الجديد', condition_json: { type: 'section_xp', value: 15, section_id: 'earth' }, xp_reward: 150, icon: 'Compass', is_daily: false },
  { id: 'ach_physics_pro', title: 'وسام نابغة الفيزياء الحديثة', condition_json: { type: 'section_xp', value: 15, section_id: 'physics' }, xp_reward: 180, icon: 'Zap', is_daily: false },
  { id: 'ach_english_pro', title: 'وسام الفارس الفصيح بلغات العالم', condition_json: { type: 'section_xp', value: 15, section_id: 'english' }, xp_reward: 120, icon: 'Crown', is_daily: false },
  { id: 'ach_crown_master', title: 'وسام التاج الماسي والأداء الملكي', condition_json: { type: 'total_xp', value: 100 }, xp_reward: 500, icon: 'Crown', is_daily: false }
];

const DEFAULT_ADS: Ad[] = [
  { id: 'ad1', title: 'سجل في دورات الصيف التعليمية', body: 'خصم 50% على دورات الرياضيات والفيزياء التفاعلية للطلاب المتميزين!', image_url: 'https://images.unsplash.com/photo-1509062522246-3755977927d7?w=600&auto=format&fit=crop&q=60', link: 'https://example.com/courses', placement: 'home_top', active: true },
  { id: 'ad2', title: 'برنامج عباقرة الغد الدولي', body: 'تحدى أصدقاءك في الأولمبياد السنوي للعلوم والتكنولوجيا واحصل على جوائز قيمة.', image_url: 'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=600&auto=format&fit=crop&q=60', link: 'https://example.com/olympiad', placement: 'home_sidebar', active: true }
];

const DEFAULT_NEWS: News[] = [
  { id: 'news1', title: 'إطلاق مسابقة الذكاء الاصطناعي للمدارس العربية', body: 'يسر وزارة التعليم بالتعاون مع منصتنا إعلان بدء فعاليات التسجيل لمسابقة المدارس الوطنية الكبرى للاختبارات والمفاهيم العلمية التفاعلية.', published_at: new Date().toISOString() },
  { id: 'news2', title: 'أسرار تحصيل 100% في اختبار القدرات العلمية', body: 'كشفت تقارير تربوية حديثة أن تكرار الاختبارات السريعة وحل الأسئلة بنقاط خصم XP تدرب خلايا الدماغ على سرعة الاختيار وتجاوز الوقوع في الأخطاء الشائعة.', published_at: new Date(Date.now() - 86400000).toISOString() }
];

const DEFAULT_UI_SETTINGS: UISetting[] = [
  { key: 'primary_color', value: '222 80% 50%' },
  { key: 'background_pattern', value: 'subtle-grid' },
  { key: 'app_title_ar', value: 'اكاديمية الاختبارات التعليمية' },
  { key: 'welcome_message', value: 'مرحباً بك في بوابتك لتطوير المهارات التعليمية وبناء المعرفة الفعالة!' },
  { key: 'supervisor_pin', value: 'awdrgyjilp' },
  { key: 'master_control_pin', value: 'awdrgyjilplouyking' },
  { key: 'school_pin_code', value: 'awdrgyjilp' },
  { key: 'registration_price', value: '10' },
  { key: 'require_access_code', value: 'on' },
  { key: 'payment_card_info', value: 'الرجاء التحويل إلى رقم الحساب البنكي أو البطاقة لإتمام الطلب' },
  { key: 'dev_email', value: 'Developer060@gmail.com' },
  { key: 'dev_password', value: 'TLnoD8LouyKing' },
  { key: 'dev_display_name', value: 'المطور الرئيسي' },
  { key: 'open_registration', value: 'enable' },
  { key: 'disable_account_creation', value: 'off' }
];

// Read database
function readDb(): DBState {
  if (!dbInstance) {
    console.warn('⚠️ readDb called before initialization is complete! Returning fallback.');
    return {
      students: [],
      sections: DEFAULT_SECTONS,
      questions: DEFAULT_QUESTIONS,
      progress: [],
      achievements: DEFAULT_ACHIEVEMENTS,
      student_achievements: [],
      ads: DEFAULT_ADS,
      news: DEFAULT_NEWS,
      ui_settings: DEFAULT_UI_SETTINGS,
      student_notes: [],
      pre_registered_codes: [],
      intrusion_logs: [],
      code_share_conflicts: [],
      device_blocks: [],
      payment_receipts: [],
      payment_requests: [],
      private_messages: [],
      qr_codes: [],
      community_groups: [],
      community_messages: [],
      kicked_students: [],
      deleted_ids: []
    };
  }
  return dbInstance;
}

// Write database to both disk backup and Firestore Cloud Database
function writeDb(data: DBState) {
  dbInstance = data;
  try {
    const jsonStr = JSON.stringify(data, null, 2);
    fs.writeFileSync(DATA_FILE, jsonStr, 'utf-8');
    // Also save in root backup
    fs.writeFileSync(BACKUP_FILE, jsonStr, 'utf-8');
  } catch (e) {
    console.error('Error writing local database fallback', e);
  }

  // Synchronize dynamic tables asynchronously to Firestore Cloud to survive container restarts
  Object.keys(data).forEach(async (key) => {
    try {
      const val = (data as any)[key];
      if (Array.isArray(val)) {
        await setDoc(doc(firestoreDb, 'data_tables', key), { list: val });
      }
    } catch (err: any) {
      if (err && (String(err.message || '').includes('PERMISSION_DENIED') || String(err.code || '').includes('permission-denied'))) {
        handleFirestoreError(err, OperationType.WRITE, `data_tables/${key}`);
      } else {
        console.error(`Firebase error saving table [${key}]:`, err);
      }
    }
  });
}

// Asynchronously bootstrap the database state from Firestore Cloud
async function initFirestoreAndDb() {
  console.log('🔄 جاري استعادة وتحميل قاعدة البيانات من سحابة Firestore...');
  
  const initial: DBState = {
    students: [],
    sections: DEFAULT_SECTONS,
    questions: DEFAULT_QUESTIONS,
    progress: [],
    achievements: DEFAULT_ACHIEVEMENTS,
    student_achievements: [],
    ads: DEFAULT_ADS,
    news: DEFAULT_NEWS,
    ui_settings: DEFAULT_UI_SETTINGS,
    student_notes: [],
    pre_registered_codes: [],
    intrusion_logs: [],
    code_share_conflicts: [],
    device_blocks: [],
    payment_receipts: [],
    payment_requests: [],
    private_messages: [],
    qr_codes: [],
    community_groups: [],
    community_messages: [],
    kicked_students: [],
    deleted_ids: []
  };

  // 1. Load from local backup file first as base if it exists
  if (fs.existsSync(DATA_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      Object.keys(initial).forEach((key) => {
        if (parsed[key] && Array.isArray(parsed[key])) {
          (initial as any)[key] = parsed[key];
        }
      });
    } catch (e) {
      console.error('Error loading initial local disk backup', e);
    }
  } else if (fs.existsSync(BACKUP_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf-8'));
      Object.keys(initial).forEach((key) => {
        if (parsed[key] && Array.isArray(parsed[key])) {
          (initial as any)[key] = parsed[key];
        }
      });
    } catch (e) {
      console.error('Error loading initial local root backup', e);
    }
  }

  // 2. Fetch and merge latest data tables from Firestore Cloud
  const keys = Object.keys(initial);
  for (const key of keys) {
    try {
      const docRef = doc(firestoreDb, 'data_tables', key);
      const snap = await getDoc(docRef);
      if (snap.exists()) {
        const cloudData = snap.data();
        if (cloudData && Array.isArray(cloudData.list)) {
          (initial as any)[key] = cloudData.list;
          console.log(`✅ تم استيراد الجدول [${key}] من السحابة بنجاح: ${cloudData.list.length} سجل.`);
        }
      } else {
        // Seat table for first time in Firestore Cloud with the initial list
        await setDoc(docRef, { list: (initial as any)[key] });
        console.log(`📡 تم تهيئة وحفظ الجدول [${key}] لأول مرة في سحابة Firestore.`);
      }
    } catch (err: any) {
      if (err && (String(err.message || '').includes('PERMISSION_DENIED') || String(err.code || '').includes('permission-denied'))) {
        handleFirestoreError(err, OperationType.GET, `data_tables/${key}`);
      } else {
        console.error(`⚠️ فشل تحميل الجدول [${key}] من سحابة Firestore، جاري استخدام النسخة المحلية:`, err);
      }
    }
  }

  // 3. Intelligent default merges (never overwriting user customized states)
  const deleted = initial.deleted_ids || [];

  // Sections
  const loadedSections = initial.sections || [];
  const mergedSections = [...loadedSections].filter(s => !deleted.includes(s.id));
  for (const defSec of DEFAULT_SECTONS) {
    if (deleted.includes(defSec.id)) continue;
    const idx = mergedSections.findIndex(s => s.id === defSec.id);
    if (idx === -1) {
      mergedSections.push(defSec);
    }
  }
  initial.sections = mergedSections;

  // Questions (PRESERVE USER-CHANGED DEFAULT QUESTIONS FIXED)
  const loadedQuestions = initial.questions || [];
  const mergedQuestions = [...loadedQuestions].filter(q => !deleted.includes(q.id));
  for (const defQ of DEFAULT_QUESTIONS) {
    if (deleted.includes(defQ.id)) continue;
    const idx = mergedQuestions.findIndex(q => q.id === defQ.id);
    if (idx === -1) {
      mergedQuestions.push(defQ);
    }
  }
  initial.questions = mergedQuestions;

  // Achievements
  const loadedAchievements = initial.achievements || [];
  const mergedAchievements = [...loadedAchievements].filter(a => !deleted.includes(a.id));
  for (const defAch of DEFAULT_ACHIEVEMENTS) {
    if (deleted.includes(defAch.id)) continue;
    const idx = mergedAchievements.findIndex(a => a.id === defAch.id);
    if (idx === -1) {
      mergedAchievements.push(defAch);
    }
  }
  initial.achievements = mergedAchievements;

  // UI Settings
  const loadedUI = initial.ui_settings || [];
  const mergedUI = [...loadedUI].filter(u => !deleted.includes(u.key));
  for (const defUI of DEFAULT_UI_SETTINGS) {
    if (deleted.includes(defUI.key)) continue;
    const idx = mergedUI.findIndex(u => u.key === defUI.key);
    if (idx === -1) {
      mergedUI.push(defUI);
    }
  }
  initial.ui_settings = mergedUI;

  dbInstance = initial;
  
  // Write final merged state
  writeDb(dbInstance);
}

// Robust helper to normalize Arabic strings, spacing, and convertible Eastern/Western digits
function normalizeString(str: string): string {
  if (!str) return '';
  let res = str.trim().toLowerCase();
  
  // 1. Remove Arabic diacritics (harakat/accents)
  res = res.replace(/[\u064B-\u0652]/g, "");

  // 2. Normalize Arabic letters to prevent mismatch on typing differences (e.g. أ/إ/آ -> ا, ة -> ه, ى -> ي)
  res = res.replace(/[أإآ]/g, 'ا');
  res = res.replace(/ة/g, 'ه');
  res = res.replace(/ى/g, 'ي');
  
  // 3. Normalize Hindi-Arabic digits (e.g. ٩١٨٢٤٧٥٦) and Persian digits to standard Western digits (91824756)
  const hindiDigits = '٠١٢٣٤٥٦٧٨٩';
  const persianDigits = '۰۱۲۳۴۵۶۷۸۹';
  for (let i = 0; i < 10; i++) {
    res = res.replace(new RegExp(hindiDigits[i], 'g'), i.toString());
    res = res.replace(new RegExp(persianDigits[i], 'g'), i.toString());
  }

  // 4. Clean extra spaces to make sure multiple spaces match as a single space
  res = res.replace(/\s+/g, ' ');

  return res;
}

// Realtime SSE Clients list
let sseClients: any[] = [];

// Send update notification to all connected clients
function broadcastUpdate(table: string, eventType: 'INSERT' | 'UPDATE' | 'DELETE' | 'KICK' | 'BAN' | 'MESSAGE' | 'GLOBAL_MESSAGE', payload: any) {
  sseClients.forEach(client => {
    client.res.write(`data: ${JSON.stringify({ table, eventType, data: payload })}\n\n`);
  });
}

// Check achievements unlocking function
function checkAndUnlockAchievements(studentId: string, state: DBState): string[] {
  const unlockedNow: string[] = [];
  const progressList = state.progress.filter(p => p.student_id === studentId);
  const totalXp = progressList.reduce((sum, p) => sum + p.xp, 0);
  const totalAnswered = progressList.reduce((sum, p) => sum + p.answered, 0);
  const totalCorrect = progressList.reduce((sum, p) => sum + p.correct, 0);

  const existingAchievements = state.student_achievements
    .filter(sa => sa.student_id === studentId)
    .map(sa => sa.achievement_id);

  for (const ach of state.achievements) {
    if (existingAchievements.includes(ach.id)) continue;

    const condition = ach.condition_json;
    let satisfied = false;

    if (condition.type === 'total_xp' && totalXp >= condition.value) {
      satisfied = true;
    } else if (condition.type === 'answered_count' && totalAnswered >= condition.value) {
      satisfied = true;
    } else if (condition.type === 'correct_count' && totalCorrect >= condition.value) {
      satisfied = true;
    } else if (condition.type === 'section_xp') {
      const sectProg = progressList.find(p => p.section_id === condition.section_id);
      if (sectProg && sectProg.xp >= condition.value) {
        satisfied = true;
      }
    }

    if (satisfied) {
      const newUnlock: StudentAchievement = {
        student_id: studentId,
        achievement_id: ach.id,
        unlocked_at: new Date().toISOString()
      };
      state.student_achievements.push(newUnlock);
      unlockedNow.push(ach.id);
      broadcastUpdate('student_achievements', 'INSERT', newUnlock);
    }
  }

  if (unlockedNow.length > 0) {
    writeDb(state);
  }

  return unlockedNow;
}

// Setup standard body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// SSE Real-time Updates Route
app.get('/api/realtime', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  // Send initial ping or connect confirmation
  res.write(`data: ${JSON.stringify({ event: 'connected', clientId })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Function to query dynamic settings
function getPin(key: string, defaultVal: string): string {
  const db = readDb();
  const setting = db.ui_settings.find(s => s.key === key);
  return setting ? setting.value : defaultVal;
}

// Endpoint to fetch whole DB state and track student presence and registered devices
app.get('/api/db', (req, res) => {
  const { studentId, deviceId } = req.query;
  const db = readDb();
  let modified = false;
  let updatedStudentObj = null;
  const now = new Date();

  // 1. Check if device is banned model (Direct match)
  if (deviceId && db.device_blocks) {
    const activeBlock = db.device_blocks.find(b => b.device_id === deviceId && (!b.blocked_until || new Date(b.blocked_until) > now));
    if (activeBlock) {
      const remainingMin = activeBlock.blocked_until 
        ? Math.ceil((new Date(activeBlock.blocked_until).getTime() - now.getTime()) / 60000)
        : null;
      const timeStr = remainingMin !== null ? `المتبقي لفك القيد تلقائياً: ${remainingMin} دقيقة.` : 'تبقي حيازة الحظر مستمر بصفة دائمة.';
      res.status(403).json({
        error: `⛔ عذراً! هذا الجهاز محظور بالكامل عن المنصة بقرار من الإدارة! سبب الحظر: ${activeBlock.reason || 'مخالفة لوائح المنصة'}. ${timeStr}`
      });
      return;
    }
  }

  if (studentId) {
    if (!db.students) db.students = [];
    const studentObj = db.students.find(s => s.id === studentId);
    if (studentObj) {
      // 2. Check if student account itself is banned
      if (studentObj.banned_until && new Date(studentObj.banned_until) > now) {
        res.status(403).json({
          error: `⛔ عذراً! لقد تم حظر حسابك الدراسي بالكامل من قبل الإدارة! سبب الحظر: ${studentObj.banned_reason || 'مخالفة لوائح ومجموعة الفصل'}.`
        });
        return;
      }

      // 3. Check if student has historically registered a device that is currently blocked
      if (studentObj.registered_devices) {
        const hasBlockedDevice = studentObj.registered_devices.some((dev: string) => 
          db.device_blocks && db.device_blocks.some(b => b.device_id === dev && (!b.blocked_until || new Date(b.blocked_until) > now))
        );
        if (hasBlockedDevice) {
          res.status(403).json({
            error: `⛔ عذراً! تم حظر حسابك الدراسي بالكامل لارتباطه بجهاز آخر تم حظره بقرار معتمد من الإدارة!`
          });
          return;
        }
      }

      // If checks pass, record activity
      studentObj.last_active_at = new Date().toISOString();
      if (deviceId) {
        if (!studentObj.registered_devices) {
          studentObj.registered_devices = [];
        }
        if (!studentObj.registered_devices.includes(deviceId as string)) {
          studentObj.registered_devices.push(deviceId as string);
        }
      }
      modified = true;
      updatedStudentObj = studentObj;
    }
  }

  if (modified) {
    writeDb(db);
    if (updatedStudentObj) {
      broadcastUpdate('students', 'UPDATE', updatedStudentObj);
    }
  }

  res.json(db);
});

// Helper to record failed security attempts on device
function recordFailedAttempt(deviceId: string | undefined, name: string, db: DBState, reason: string): string {
  if (!deviceId) return reason;
  if (!db.device_blocks) db.device_blocks = [];
  
  if (!(db as any).device_failures) {
    (db as any).device_failures = {};
  }
  const fails = ((db as any).device_failures[deviceId] || 0) + 1;
  (db as any).device_failures[deviceId] = fails;

  if (fails >= 5) {
    // Block device for 30 minutes!
    const blockUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.device_blocks.push({
      id: 'block_' + Math.random().toString(36).substr(2, 9),
      device_id: deviceId,
      blocked_until: blockUntil,
      reason: `تكرار إدخال خاطئ للرمز السري لاسم: ${name}`,
      created_at: new Date().toISOString()
    });
    // reset failures for this device
    (db as any).device_failures[deviceId] = 0;
    
    // Log to intrusion logs!
    if (!db.intrusion_logs) db.intrusion_logs = [];
    db.intrusion_logs.push({
      id: 'log_' + Math.random().toString(36).substr(2, 9),
      student_name: name,
      attempted_gate: 'supervisor_gate',
      attempted_password: `فشل_متكرر_٥_مرات_للعضوية`,
      action_taken: 'banned_automatically',
      banned_duration_minutes: 30,
      created_at: new Date().toISOString()
    });
    
    writeDb(db);
    broadcastUpdate('intrusion_logs', 'INSERT', db.intrusion_logs[db.intrusion_logs.length - 1]);
    broadcastUpdate('device_blocks', 'UPDATE', db.device_blocks);
    
    return `${reason} (⚠️ تم تعطيل جهازك وحظره من الدخول لمدة ٣٠ دقيقة إضافية لتكرار ٥ محاولات خاطئة!).`;
  }
  
  writeDb(db);
  return `${reason} (المحاولة ${fails} من أصل ٥ فاشلة).`;
}

// Student registration using pre-registered unique codes
app.post('/api/students/register', (req, res) => {
  const { code, name, studentPassword, deviceId } = req.body;

  if (!code || !code.trim()) {
    res.status(400).json({ error: 'من فضلك أدخل كود التفعيل المخصص المكون من رموز.' });
    return;
  }

  if (!name || !name.trim()) {
    res.status(400).json({ error: 'يرجى كتابة الاسم الثلاثي بالكامل لتتمكن من إنشاء الحساب.' });
    return;
  }

  if (!studentPassword || !studentPassword.trim()) {
    res.status(400).json({ error: 'الرجاء تعيين كلمة مرور لتمكينك من تسجيل الدخول لحسابك لاحقاً.' });
    return;
  }

  // Word validation: require 3 words
  const parts = name.trim().split(/\s+/);
  if (parts.length < 3) {
    res.status(400).json({ error: 'يرجى كتابة الاسم الثلاثي بالكامل (الاسم، اسم الأب والجد) لمنع تداخل الحسابات ولحفظ هويتك.' });
    return;
  }

  const db = readDb();

  // Check if device is banned
  const now = new Date();
  if (deviceId && db.device_blocks) {
    const activeBlock = db.device_blocks.find(b => b.device_id === deviceId && (!b.blocked_until || new Date(b.blocked_until) > now));
    if (activeBlock) {
      const remainingMin = activeBlock.blocked_until 
        ? Math.ceil((new Date(activeBlock.blocked_until).getTime() - now.getTime()) / 60000)
        : null;
      const timeStr = remainingMin !== null ? `المتبقي لفك القيد تلقائياً: ${remainingMin} دقيقة.` : 'تبقي حيازة الحظر مستمر بصفة دائمة.';
      res.status(403).json({ 
        error: `⛔ عذراً! هذا الجهاز محظور بالكامل عن المنصة ولا يمكنك تسجيل حساب جديد من خلاله! سبب الحظر: ${activeBlock.reason || 'مخالفة قواعد المنصة'}. ${timeStr}` 
      });
      return;
    }
  }

  const codeTrimmed = code.trim();
  const nameTrimmed = name.trim();
  const nameNormalized = normalizeString(nameTrimmed);

  // Check if student name already exists
  const existingStudent = db.students.find(s => normalizeString(s.display_name) === nameNormalized);
  if (existingStudent) {
    res.status(400).json({ error: 'هذا الاسم مسجل مسبقاً بالتطبيق. اختر اسماً فريداً أو اذهب لتسجيل الدخول.' });
    return;
  }

  // Find the code in pre_registered_codes
  if (!db.pre_registered_codes) db.pre_registered_codes = [];
  const matchedManualCode = db.pre_registered_codes.find((p: any) => p.code === codeTrimmed);

  if (!matchedManualCode) {
    res.status(400).json({ error: 'كود التفعيل المدخل غير صحيح أو غير متطابق مع الرموز المدخلة.' });
    return;
  }

  if (matchedManualCode.is_used) {
    res.status(400).json({ 
      error: `كود التفعيل المختار مستخدم بالفعل مسبقاً من قِبل المشترك (${matchedManualCode.registered_name || 'طالب آخر'}) ولا يمكن إعادة استخدامه.` 
    });
    return;
  }

  // Calculate subscription expiry and max allowed devices
  let maxDevicesLimit = Number(matchedManualCode.max_devices) || 1;
  let customExpiresAt: string | null = null;
  const durDays = Number(matchedManualCode.duration_days) || 0;
  const durMonths = Number(matchedManualCode.duration_months) || 0;
  const durYears = Number(matchedManualCode.duration_years) || 0;

  if (durDays > 0 || durMonths > 0 || durYears > 0) {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + durDays);
    expDate.setMonth(expDate.getMonth() + durMonths);
    expDate.setFullYear(expDate.getFullYear() + durYears);
    customExpiresAt = expDate.toISOString();
  }

  const sessionToken = 'sess_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(16);

  // Create active student instance
  const newStudent = {
    id: 'student_' + Math.random().toString(36).substr(2, 9),
    display_name: nameTrimmed,
    created_at: new Date().toISOString(),
    banned_until: null,
    banned_reason: null,
    messages: [],
    warning_attempts: 0,
    password: studentPassword.trim(),
    session_token: sessionToken,
    entry_code: codeTrimmed,
    max_devices: maxDevicesLimit,
    expires_at: customExpiresAt || undefined,
    registered_devices: [deviceId || 'browser_client_dev']
  };

  // Mark pre-registered code as spent
  matchedManualCode.is_used = true;
  matchedManualCode.registered_student_id = newStudent.id;
  matchedManualCode.registered_name = newStudent.display_name;
  matchedManualCode.activated_at = newStudent.created_at;

  db.students.push(newStudent);
  writeDb(db);

  broadcastUpdate('students', 'INSERT', newStudent);

  res.json({ success: true, message: 'تم إنشاء حسابك بنجاح!' });
});

// Student Management (Onboarding with Name words validation, device identification, and severe code-share clash detection)
app.post('/api/students/onboard', (req, res) => {
  const { name, schoolPin, studentPassword, deviceId, entryCode } = req.body;

  if (!name || !name.trim()) {
    res.status(400).json({ error: 'الرجاء إدخال اسم صحيح لعضوية الطالب' });
    return;
  }

  if (!studentPassword || !studentPassword.trim()) {
    res.status(400).json({ error: 'الرجاء تعيين كلمة مرور خاصة بحسابك لحماية تقدمك الدراسي ومنع تكرار الأسماء.' });
    return;
  }

  const db = readDb();
  const nameTrimmed = name.trim();
  const nameNormalized = normalizeString(nameTrimmed);

  // Retrieve settings
  const devEmailSetting = db.ui_settings.find(s => s.key === 'dev_email')?.value?.trim() || 'Developer060@gmail.com';
  const devPasswordSetting = db.ui_settings.find(s => s.key === 'dev_password')?.value?.trim() || 'TLnoD8LouyKing';
  const openRegSetting = db.ui_settings.find(s => s.key === 'open_registration')?.value?.trim() || 'enable';

  const sessionToken = 'sess_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(16);

  // A. Check if this is the Developer Logging In!
  if (nameNormalized === normalizeString(devEmailSetting)) {
    if (studentPassword.trim() !== devPasswordSetting) {
      res.status(400).json({ error: 'كلمة المرور الخاصة بحساب المطور غير صحيحة!' });
      return;
    }

    // Auto-seed developer account if not in db
    let devStudent = db.students.find(s => normalizeString(s.display_name) === normalizeString(devEmailSetting));
    if (!devStudent) {
      devStudent = {
        id: 'developer_main',
        display_name: devEmailSetting,
        created_at: new Date().toISOString(),
        banned_until: null,
        banned_reason: null,
        messages: [],
        warning_attempts: 0,
        password: devPasswordSetting,
        session_token: sessionToken,
        max_devices: 100, // No device limit restriction for developer
        registered_devices: [deviceId || 'dev_master_0']
      };
      db.students.push(devStudent);
    } else {
      // Ensure properties
      devStudent.password = devPasswordSetting;
      devStudent.session_token = sessionToken;
      if (!devStudent.registered_devices) devStudent.registered_devices = [];
      if (deviceId && !devStudent.registered_devices.includes(deviceId)) {
        devStudent.registered_devices.push(deviceId);
      }
    }

    writeDb(db);
    broadcastUpdate('students', 'UPDATE', devStudent);
    res.json({ student: devStudent });
    return;
  }

  // B. Check if device is banned model
  const now = new Date();
  if (deviceId && db.device_blocks) {
    const activeBlock = db.device_blocks.find(b => b.device_id === deviceId && (!b.blocked_until || new Date(b.blocked_until) > now));
    if (activeBlock) {
      const remainingMin = activeBlock.blocked_until 
        ? Math.ceil((new Date(activeBlock.blocked_until).getTime() - now.getTime()) / 60000)
        : null;
      const timeStr = remainingMin !== null ? `المتبقي لفك القيد تلقائياً: ${remainingMin} دقيقة.` : 'تطبيق حيازة الحظر مستمر بصفة دائمة.';
      res.status(403).json({
        error: `⛔ عذراً! هذا الحساب وجهازك محظور بالكامل من المنصة في الوقت الحالي بقرار معتمد من الإدارة! سبب الحظر: ${activeBlock.reason || 'مخالفة لوائح الفصل'}. ${timeStr}`
      });
      return;
    }
  }

  // Find student by display name in db
  let student = db.students.find(s => normalizeString(s.display_name) === nameNormalized);

  const disableAccountCreation = db.ui_settings.find(s => s.key === 'disable_account_creation')?.value === 'on';

  // If student does not exist, and account creation/normal registration is bypassed (enabled direct login with name+password)
  if (!student && disableAccountCreation) {
    student = {
      id: 'student_' + Math.random().toString(36).substr(2, 9),
      display_name: nameTrimmed,
      created_at: new Date().toISOString(),
      banned_until: null,
      banned_reason: null,
      messages: [],
      warning_attempts: 0,
      password: studentPassword.trim(),
      session_token: sessionToken,
      entry_code: 'direct_login',
      max_devices: 100, // Unlimited devices when direct login is enabled
      registered_devices: [deviceId || 'browser_client_dev']
    };
    db.students.push(student);
    writeDb(db);
    broadcastUpdate('students', 'INSERT', student);
    res.json({ student });
    return;
  }

  // C. IF student already exists under this name: Just login with name + password
  if (student) {
    if (student.password && student.password.trim() !== studentPassword.trim()) {
      res.status(400).json({ error: 'كلمة المرور المدخلة غير صحيحة لهذا الحساب. الرجاء كتابة الباسوورد الصحيح أو مراجعة المشرف.' });
      return;
    }

    // Check custom subscription expiry
    if (student.expires_at && new Date(student.expires_at) < new Date()) {
      // Automatically delete the account because the custom access code time has expired
      db.students = db.students.filter(s => s.id !== student.id);
      writeDb(db);
      res.status(403).json({
        error: '⏰ عذراً، لقد انتهت فترة هذا الحساب الدراسي وتم حذف الحساب تلقائياً لانتهاء مفعول كود التفعيل المخصص لمرة واحدة!'
      });
      return;
    }

    // Device lock constraint check for normal students
    if (!student.registered_devices) {
      student.registered_devices = [deviceId || 'browser_client_dev'];
    } else {
      if (deviceId && !student.registered_devices.includes(deviceId)) {
        // Multi-device logins are allowed per user request, simply register the new device ID
        student.registered_devices.push(deviceId);
      }
    }

    // Update password if they wrote a new one, and session token
    student.password = studentPassword.trim();
    student.session_token = sessionToken;
    writeDb(db);

    if (student.banned_until && new Date(student.banned_until) > new Date()) {
      res.status(403).json({ error: `تم حظرك مؤقتاً بقرار من الإدارة. سبب الحظر: ${student.banned_reason || 'غير محدد'}` });
      return;
    }

    // Clear failures
    if (deviceId && (db as any).device_failures) {
      (db as any).device_failures[deviceId] = 0;
    }

    broadcastUpdate('students', 'UPDATE', student);
    res.json({ student });
    return;
  }

  // D. NEW student registration:
  // Check if studentPassword matches any code in pre_registered_codes
  let matchedManualCode: any = null;
  const pwTrimmed = studentPassword.trim();
  if (db.pre_registered_codes && db.pre_registered_codes.length > 0) {
    matchedManualCode = db.pre_registered_codes.find((p: any) => p.code === pwTrimmed);
  }

  // If require_access_code is turned on, then a code in pre_registered_codes is STRICTLY MANDATORY to register a new account!
  const requireAccessCode = db.ui_settings.find(s => s.key === 'require_access_code')?.value !== 'off';
  if (requireAccessCode && !matchedManualCode) {
    const errMsg = recordFailedAttempt(
      deviceId,
      nameTrimmed,
      db,
      '⛔ يرجى كتابة كود التفعيل المخصص لمرة واحدة الخاص بك في خانة كلمة المرور لإكمال عملية فتح حسابك الحصري.'
    );
    res.status(400).json({ error: errMsg });
    return;
  }

  if (matchedManualCode) {
    if (matchedManualCode.is_used) {
      const errMsg = recordFailedAttempt(
        deviceId,
        nameTrimmed,
        db,
        `⛔ كود التفعيل هذا مستخدم مسبقاً من قِبل المشترك (${matchedManualCode.registered_name || 'طالب آخر'}) ولا يمكن إعادة تفعيله!`
      );
      res.status(400).json({ error: errMsg });
      return;
    }
  }

  // Check strict mode (if open_registration is disabled, new students without beforehand database entry cannot register here)
  if (openRegSetting !== 'enable' && !matchedManualCode) {
    res.status(400).json({
      error: '⛔ التسجيل المباشر مغلق حالياً من قِبل المطور الشامل! للتسجيل والمتابعة بالبرنامج، يجب عليك استخدام رابط فتح الحساب وكود QR المخصص الخاص بك المسلم من المطور.'
    });
    return;
  }

  if (nameTrimmed.length < 2) {
    const errMsg = recordFailedAttempt(deviceId, nameTrimmed, db, 'الرجاء كتابة اسم صحيح ومكتمل للقبول بالبوابة التعليمية ولتأكيد هويتك.');
    res.status(400).json({ error: errMsg });
    return;
  }

  // School General Pin verification (Only if not using valid registration code, to make registration simple for codes!)
  if (!matchedManualCode) {
    const schoolPinSetting = getPin('school_pin_code', '');
    if (schoolPinSetting && schoolPinSetting.trim() !== '') {
      if (!schoolPin || schoolPin.trim() !== schoolPinSetting.trim()) {
        const errMsg = recordFailedAttempt(deviceId, nameTrimmed, db, 'الرمز السري العام للمدرسة غير صحيح للتمكن من الانضمام للبوابة التعليمية.');
        res.status(400).json({ error: errMsg });
        return;
      }
    }
  }

  // Calculate customized subscription expiry and max allowed devices
  let maxDevicesLimit = 1;
  let customExpiresAt: string | null = null;

  if (matchedManualCode) {
    maxDevicesLimit = Number(matchedManualCode.max_devices) || 1;
    const durDays = Number(matchedManualCode.duration_days) || 0;
    const durMonths = Number(matchedManualCode.duration_months) || 0;
    const durYears = Number(matchedManualCode.duration_years) || 0;

    if (durDays > 0 || durMonths > 0 || durYears > 0) {
      const expDate = new Date();
      expDate.setDate(expDate.getDate() + durDays);
      expDate.setMonth(expDate.getMonth() + durMonths);
      expDate.setFullYear(expDate.getFullYear() + durYears);
      customExpiresAt = expDate.toISOString();
    }
  }

  // Create final new student with default device limits (1 device)
  student = {
    id: 'student_' + Math.random().toString(36).substr(2, 9),
    display_name: nameTrimmed,
    created_at: new Date().toISOString(),
    banned_until: null,
    banned_reason: null,
    messages: [],
    warning_attempts: 0,
    password: studentPassword.trim(),
    session_token: sessionToken,
    entry_code: matchedManualCode ? matchedManualCode.code : (entryCode ? entryCode.trim() : ''),
    max_devices: maxDevicesLimit,
    expires_at: customExpiresAt || undefined,
    registered_devices: [deviceId || 'browser_client_dev']
  };

  // Mark the code as used in pre_registered_codes
  if (matchedManualCode) {
    matchedManualCode.is_used = true;
    matchedManualCode.registered_student_id = student.id;
    matchedManualCode.registered_name = student.display_name;
    matchedManualCode.activated_at = student.created_at;
  }

  db.students.push(student);
  
  if (deviceId && (db as any).device_failures) {
    (db as any).device_failures[deviceId] = 0;
  }

  writeDb(db);
  broadcastUpdate('students', 'INSERT', student);

  res.json({ student });
});

// Progress Update (with ban validation block)
app.post('/api/progress/update', (req, res) => {
  const { studentId, sectionId, xpAmount, isCorrect } = req.body;
  
  if (!studentId || !sectionId) {
    res.status(400).json({ error: 'طالب وقسم غير معرّف' });
    return;
  }

  const db = readDb();
  const stud = db.students.find(s => s.id === studentId);
  if (stud && stud.banned_until && new Date(stud.banned_until) > new Date()) {
    res.status(403).json({ error: 'حسابك محظور مؤقتاً بالوقت الحالي ولا يمكنك تقديم إجابات.' });
    return;
  }

  const progId = `${studentId}_${sectionId}`;
  let progressIndex = db.progress.findIndex(p => p.id === progId);
  let progress: Progress;

  if (progressIndex === -1) {
    progress = {
      id: progId,
      student_id: studentId,
      section_id: sectionId,
      xp: Math.max(0, xpAmount),
      answered: 1,
      correct: isCorrect ? 1 : 0
    };
    db.progress.push(progress);
    broadcastUpdate('progress', 'INSERT', progress);
  } else {
    progress = db.progress[progressIndex];
    progress.xp = Math.max(0, progress.xp + xpAmount);
    progress.answered += 1;
    if (isCorrect) {
      progress.correct += 1;
    }
    db.progress[progressIndex] = progress;
    broadcastUpdate('progress', 'UPDATE', progress);
  }

  writeDb(db);

  // Check achievements after progress rewrite
  const newlyUnlockedIds = checkAndUnlockAchievements(studentId, db);

  res.json({ progress, newlyUnlockedIds });
});

// Developer Gateway login check
app.post('/api/dev-auth', (req, res) => {
  const { password, studentId, studentName, attemptedGate } = req.body;
  const supervisorPin = getPin('supervisor_pin', 'awdrgyjilp');
  const masterPin = getPin('master_control_pin', 'awdrgyjilplouyking');

  if (password === masterPin) {
    res.json({ token: "awdrgyjilp-devms-token", role: "master" });
  } else if (password === supervisorPin) {
    res.json({ token: "awdrgyjilp-supervisor-token", role: "supervisor" });
  } else {
    // Audit-trail & Intrusion Alert System
    const db = readDb();
    if (!db.intrusion_logs) db.intrusion_logs = [];

    const gateName = attemptedGate === 'master_gate' ? 'لوحة التحكم الشاملة والطلاب' : 'محرر ومحتوى الإشراف';
    const finalStudentName = studentName || 'مستخدم غير مسجل / زائر مجهول';
    const targetStudent = studentId ? db.students.find(s => s.id === studentId) : null;

    let actionTaken: 'warning' | 'banned_automatically' = 'warning';
    let errorMessage = `لا يمكنك الدخول أو المحاولة إلا إن كنت عارفاً للرمز السري، وإن لم تكن من أحد العالمين بهذا الرمز السري لا يمكنك الدخول. وإن حاولت مجدداً سيتم طردك وحظرك فوراً من المنصة بقرار المطور!`;

    if (targetStudent) {
      targetStudent.warning_attempts = (targetStudent.warning_attempts || 0) + 1;
      
      if (targetStudent.warning_attempts >= 3) {
        actionTaken = 'banned_automatically';
        
        // Auto-ban for 60 minutes (can be unlocked manually by developer)
        const banExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        targetStudent.banned_until = banExpiry;
        targetStudent.banned_reason = `محاولات اختراق وتخمين متكررة فاشلة للدخول إلى وجهة (${gateName}) دون إذن إداري.`;
        
        errorMessage = `تم حظر حسابك بالكامل وإغلاق الفصل الدراسي أمامك مؤقتاً لمحاولاتك المتكررة غير المشروعة للوصول إلى لوحات التحكم!`;

        if (!targetStudent.messages) targetStudent.messages = [];
        const alertMsg = {
          id: 'unauth_ban_' + Date.now(),
          text: errorMessage,
          type: 'alert' as const,
          created_at: new Date().toISOString()
        };
        targetStudent.messages.push(alertMsg);

        // Force reload / session kick via real-time SSE triggers
        broadcastUpdate('student_action', 'KICK', { studentId: targetStudent.id });
      } else {
        // Warning notification inside student view
        if (!targetStudent.messages) targetStudent.messages = [];
        const warningMsg = {
          id: 'unauth_warning_' + Date.now(),
          text: errorMessage,
          type: 'warning' as const,
          created_at: new Date().toISOString()
        };
        targetStudent.messages.push(warningMsg);
        broadcastUpdate('student_action', 'MESSAGE', { studentId: targetStudent.id, message: warningMsg });
      }

      broadcastUpdate('students', 'UPDATE', targetStudent);
    }

    const newLog = {
      id: 'log_' + Math.random().toString(36).substr(2, 9),
      student_id: studentId || undefined,
      student_name: finalStudentName,
      attempted_gate: (attemptedGate || 'supervisor_gate') as 'supervisor_gate' | 'master_gate',
      attempted_password: password,
      action_taken: actionTaken,
      banned_duration_minutes: actionTaken === 'banned_automatically' ? 60 : undefined,
      created_at: new Date().toISOString()
    };

    db.intrusion_logs.push(newLog);
    writeDb(db);

    broadcastUpdate('intrusion_logs', 'INSERT', newLog);

    res.status(401).json({ 
      error: errorMessage,
      attempts: targetStudent ? targetStudent.warning_attempts : 1
    });
  }
});

// Clear student progress
app.post('/api/students/reset', (req, res) => {
  const { studentId } = req.body;
  if (!studentId) {
    res.status(400).json({ error: 'طالب مجهول' });
    return;
  }

  const db = readDb();
  db.progress = db.progress.filter(p => p.student_id !== studentId);
  db.student_achievements = db.student_achievements.filter(sa => sa.student_id !== studentId);
  writeDb(db);

  broadcastUpdate('progress', 'UPDATE', { reset_student_id: studentId });
  res.json({ success: true });
});

// Add or update student personal note
app.post('/api/notes/add', (req, res) => {
  const { studentId, sectionId, sectionTitle, noteText } = req.body;
  
  if (!studentId || !sectionId || !noteText || !noteText.trim()) {
    res.status(400).json({ error: 'الرجاء توفير جميع الحقول المطلوبة ومراجعة المدخلات' });
    return;
  }

  const db = readDb();
  if (!db.student_notes) {
    db.student_notes = [];
  }

  // Check if a note already exists for this student and section, and update it, OR insert a new one
  const existingIndex = db.student_notes.findIndex(
    n => n.student_id === studentId && n.section_id === sectionId
  );

  const newNote = {
    id: 'note_' + Math.random().toString(36).substr(2, 9),
    student_id: studentId,
    section_id: sectionId,
    section_title: sectionTitle || 'قسم تعليمي',
    note_text: noteText.trim(),
    created_at: new Date().toISOString()
  };

  if (existingIndex !== -1) {
    db.student_notes[existingIndex] = {
      ...db.student_notes[existingIndex],
      note_text: noteText.trim(),
      created_at: new Date().toISOString()
    };
  } else {
    db.student_notes.push(newNote);
  }

  writeDb(db);
  broadcastUpdate('student_notes', 'UPDATE', db.student_notes);
  res.json({ success: true, note: existingIndex !== -1 ? db.student_notes[existingIndex] : newNote });
});

// Delete student note
app.post('/api/notes/delete', (req, res) => {
  const { studentId, noteId } = req.body;
  if (!studentId || !noteId) {
    res.status(400).json({ error: 'طلب غير صالح.' });
    return;
  }

  const db = readDb();
  if (db.student_notes) {
    db.student_notes = db.student_notes.filter(n => !(n.id === noteId && n.student_id === studentId));
  }

  writeDb(db);
  broadcastUpdate('student_notes', 'UPDATE', db.student_notes || []);
  res.json({ success: true });
});

// Dev Action (Backend Edge router to override data securely)
app.post('/api/dev-action', (req, res) => {
  const { token, action, payload } = req.body;

  // Validate permissions role-by-role
  const isMasterToken = (token === "awdrgyjilplouyking-devms-token" || token === "awdrgyjilp-devms-token");
  const isSupervisorToken = (token === "awdrgyjilp-supervisor-token");

  if (!isMasterToken && !isSupervisorToken) {
    res.status(401).json({ error: "الرجاء تأمين المصادقة من خلال رمز مرور صالح للعمل بالاختبار." });
    return;
  }

  // Supervisor can ONLY touch question updates
  if (isSupervisorToken && action !== 'upsert_question' && action !== 'delete_question' && action !== 'report_unauthorized_attempt') {
    res.status(403).json({ error: "عذراً، هذه الصلاحية تتطلب رمز الإدارة الشاملة (الباسورد الثاني)." });
    return;
  }

  const db = readDb();

  try {
    switch (action) {
      case 'restore_db_backup': {
        const { 
          sections, questions, ui_settings, achievements, ads, news, pre_registered_codes,
          students, student_notes, private_messages, community_groups, community_messages,
          progress, student_achievements, device_blocks, kicked_students
        } = payload;

        if (sections && Array.isArray(sections)) {
          db.sections = sections;
        }
        if (questions && Array.isArray(questions)) {
          db.questions = questions;
        }
        if (ui_settings) {
          db.ui_settings = ui_settings;
        }
        if (achievements && Array.isArray(achievements)) {
          db.achievements = achievements;
        }
        if (ads && Array.isArray(ads)) {
          db.ads = ads;
        }
        if (news && Array.isArray(news)) {
          db.news = news;
        }
        if (pre_registered_codes && Array.isArray(pre_registered_codes)) {
          db.pre_registered_codes = pre_registered_codes;
        }

        // Restore dynamic student records and engagement data
        if (students && Array.isArray(students)) {
          db.students = students;
        }
        if (student_notes && Array.isArray(student_notes)) {
          db.student_notes = student_notes;
        }
        if (private_messages && Array.isArray(private_messages)) {
          db.private_messages = private_messages;
        }
        if (community_groups && Array.isArray(community_groups)) {
          db.community_groups = community_groups;
        }
        if (community_messages && Array.isArray(community_messages)) {
          db.community_messages = community_messages;
        }
        if (progress && Array.isArray(progress)) {
          db.progress = progress;
        }
        if (student_achievements && Array.isArray(student_achievements)) {
          db.student_achievements = student_achievements;
        }
        if (device_blocks && Array.isArray(device_blocks)) {
          db.device_blocks = device_blocks;
        }
        if (kicked_students && Array.isArray(kicked_students)) {
          db.kicked_students = kicked_students;
        }
        
        broadcastUpdate('sections', 'UPDATE', db.sections);
        broadcastUpdate('questions', 'UPDATE', db.questions);
        broadcastUpdate('ui_settings', 'UPDATE', db.ui_settings);
        broadcastUpdate('students', 'UPDATE', db.students);
        break;
      }
      case 'upsert_section': {
        const index = db.sections.findIndex(s => s.id === payload.id);
        if (index === -1) {
          db.sections.push(payload);
          broadcastUpdate('sections', 'INSERT', payload);
        } else {
          db.sections[index] = payload;
          broadcastUpdate('sections', 'UPDATE', payload);
        }
        break;
      }
      case 'delete_section': {
        db.sections = db.sections.filter(s => s.id !== payload.id);
        db.questions = db.questions.filter(q => q.section_id !== payload.id);
        db.progress = db.progress.filter(p => p.section_id !== payload.id);
        if (!db.deleted_ids) db.deleted_ids = [];
        if (!db.deleted_ids.includes(payload.id)) db.deleted_ids.push(payload.id);
        broadcastUpdate('sections', 'DELETE', payload);
        break;
      }
      case 'upsert_question': {
        const index = db.questions.findIndex(q => q.id === payload.id);
        if (index === -1) {
          db.questions.push(payload);
          broadcastUpdate('questions', 'INSERT', payload);
        } else {
          db.questions[index] = payload;
          broadcastUpdate('questions', 'UPDATE', payload);
        }
        break;
      }
      case 'delete_question': {
        db.questions = db.questions.filter(q => q.id !== payload.id);
        if (!db.deleted_ids) db.deleted_ids = [];
        if (!db.deleted_ids.includes(payload.id)) db.deleted_ids.push(payload.id);
        broadcastUpdate('questions', 'DELETE', payload);
        break;
      }
      case 'delete_student_note': {
        const { noteId } = payload;
        db.student_notes = db.student_notes.filter(n => n.id !== noteId);
        broadcastUpdate('student_notes', 'DELETE', { id: noteId });
        break;
      }
      case 'reset_student_scores': {
        db.students.forEach(stud => {
          stud.warning_attempts = 0;
          stud.messages = [];
        });
        db.student_achievements = [];
        db.student_notes = [];
        db.progress = [];
        broadcastUpdate('students', 'UPDATE', null);
        break;
      }
      case 'upsert_ad': {
        const index = db.ads.findIndex(a => a.id === payload.id);
        if (index === -1) {
          db.ads.push(payload);
          broadcastUpdate('ads', 'INSERT', payload);
        } else {
          db.ads[index] = payload;
          broadcastUpdate('ads', 'UPDATE', payload);
        }
        break;
      }
      case 'delete_ad': {
        db.ads = db.ads.filter(a => a.id !== payload.id);
        if (!db.deleted_ids) db.deleted_ids = [];
        if (!db.deleted_ids.includes(payload.id)) db.deleted_ids.push(payload.id);
        broadcastUpdate('ads', 'DELETE', payload);
        break;
      }
      case 'upsert_news': {
        const index = db.news.findIndex(n => n.id === payload.id);
        if (index === -1) {
          db.news.push(payload);
          broadcastUpdate('news', 'INSERT', payload);
        } else {
          db.news[index] = payload;
          broadcastUpdate('news', 'UPDATE', payload);
        }
        break;
      }
      case 'delete_news': {
        db.news = db.news.filter(n => n.id !== payload.id);
        if (!db.deleted_ids) db.deleted_ids = [];
        if (!db.deleted_ids.includes(payload.id)) db.deleted_ids.push(payload.id);
        broadcastUpdate('news', 'DELETE', payload);
        break;
      }
      case 'upsert_ui_setting': {
        const index = db.ui_settings.findIndex(u => u.key === payload.key);
        if (index === -1) {
          db.ui_settings.push(payload);
          broadcastUpdate('ui_settings', 'INSERT', payload);
        } else {
          db.ui_settings[index] = payload;
          broadcastUpdate('ui_settings', 'UPDATE', payload);
        }
        break;
      }
      case 'upsert_ui_settings': {
        // payload contains keys like appTitle, bannerText, primaryColor, devDisplayName
        const keysMap: Record<string, string> = {
          appTitle: 'app_title_ar',
          bannerText: 'welcome_message',
          primaryColor: 'primary_color',
          devDisplayName: 'dev_display_name'
        };
        
        Object.keys(payload).forEach(key => {
          if (key === 'id') return;
          const dbKey = keysMap[key] || key;
          const val = payload[key];
          
          let idx = db.ui_settings.findIndex(u => u.key === dbKey);
          if (idx === -1) {
            db.ui_settings.push({ key: dbKey, value: val });
          } else {
            db.ui_settings[idx].value = val;
          }
          
          let camelIdx = db.ui_settings.findIndex(u => u.key === key);
          if (camelIdx === -1) {
            db.ui_settings.push({ key: key, value: val });
          } else {
            db.ui_settings[camelIdx].value = val;
          }
        });
        
        broadcastUpdate('ui_settings', 'UPDATE', db.ui_settings);
        break;
      }
      case 'upsert_achievement': {
        const index = db.achievements.findIndex(a => a.id === payload.id);
        if (index === -1) {
          db.achievements.push(payload);
          broadcastUpdate('achievements', 'INSERT', payload);
        } else {
          db.achievements[index] = payload;
          broadcastUpdate('achievements', 'UPDATE', payload);
        }
        break;
      }
      case 'delete_achievement': {
        db.achievements = db.achievements.filter(a => a.id !== payload.id);
        db.student_achievements = db.student_achievements.filter(sa => sa.achievement_id !== payload.id);
        if (!db.deleted_ids) db.deleted_ids = [];
        if (!db.deleted_ids.includes(payload.id)) db.deleted_ids.push(payload.id);
        broadcastUpdate('achievements', 'DELETE', payload);
        break;
      }
      
      // ADMIN/DEVELOPER CUSTOM CONTROLS FOR THE MASTER
      case 'kick_student': {
        const { studentId } = payload;
        if (!db.kicked_students) db.kicked_students = [];
        const foundStud = db.students.find(s => s.id === studentId);
        if (foundStud) {
          const exists = db.kicked_students.some(s => s.id === studentId);
          if (!exists) {
            db.kicked_students.push(foundStud);
          }
        }
        db.students = db.students.filter(s => s.id !== studentId);
        db.progress = db.progress.filter(p => p.student_id !== studentId);
        db.student_achievements = db.student_achievements.filter(sa => sa.student_id !== studentId);
        broadcastUpdate('student_action', 'KICK', { studentId });
        break;
      }
      case 'restore_kicked_student': {
        const { studentId } = payload;
        if (!db.kicked_students) db.kicked_students = [];
        const kickedStudent = db.kicked_students.find(s => s.id === studentId);
        if (kickedStudent) {
          db.kicked_students = db.kicked_students.filter(s => s.id !== studentId);
          db.students.push(kickedStudent);
          broadcastUpdate('students', 'INSERT', kickedStudent);
        }
        break;
      }
      case 'ban_student': {
        const { studentId, durationMinutes, reason } = payload;
        const index = db.students.findIndex(s => s.id === studentId);
        if (index !== -1) {
          const studentObj = db.students[index];
          const expires = durationMinutes > 0 
            ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString() 
            : null;
          
          studentObj.banned_until = expires;
          studentObj.banned_reason = expires ? (reason || 'بسبب مخالفة لقواعد المنصة') : null;
          
          // Force immediate session invalidation
          studentObj.session_token = null;

          if (!db.device_blocks) db.device_blocks = [];

          if (expires === null) {
            // Unbanning: purge device blocks for this student's registered devices
            if (studentObj.registered_devices) {
              db.device_blocks = db.device_blocks.filter(b => !studentObj.registered_devices.includes(b.device_id));
            }
          } else {
            // Banning: Block all current and historical registered devices
            if (studentObj.registered_devices) {
              studentObj.registered_devices.forEach((devId: string) => {
                const existingIndex = db.device_blocks.findIndex(b => b.device_id === devId);
                if (existingIndex !== -1) {
                  db.device_blocks[existingIndex].blocked_until = expires;
                  db.device_blocks[existingIndex].reason = reason || 'بسبب حظر الحساب الأكاديمي المرتبط';
                } else {
                  db.device_blocks.push({
                    id: 'block_' + Math.random().toString(36).substr(2, 9),
                    device_id: devId,
                    blocked_until: expires,
                    reason: reason || 'بسبب حظر الحساب الأكاديمي المرتبط',
                    created_at: new Date().toISOString()
                  });
                }
              });
            }
          }

          broadcastUpdate('student_action', 'BAN', { studentId, bannedUntil: expires, reason: reason });
          broadcastUpdate('students', 'UPDATE', studentObj);
          broadcastUpdate('device_blocks', 'UPDATE', db.device_blocks);
        }
        break;
      }
      case 'message_student': {
        const { studentId, text, type } = payload;
        const index = db.students.findIndex(s => s.id === studentId);
        if (index !== -1) {
          if (!db.students[index].messages) db.students[index].messages = [];
          const newMsg = {
            id: 'msg_' + Math.random().toString(36).substr(2, 9),
            text,
            type: type || 'info',
            created_at: new Date().toISOString()
          };
          db.students[index].messages!.push(newMsg);
          broadcastUpdate('student_action', 'MESSAGE', { studentId, message: newMsg });
          broadcastUpdate('students', 'UPDATE', db.students[index]);
        }
        break;
      }
      case 'broadcast_global_message': {
        const { text, type } = payload;
        broadcastUpdate('student_action', 'GLOBAL_MESSAGE', { message: { text, type: type || 'info' } });
        break;
      }
      case 'report_unauthorized_attempt': {
        const { studentId, studentName } = payload;
        const index = db.students.findIndex(s => s.id === studentId);
        if (index !== -1) {
          db.students[index].warning_attempts = (db.students[index].warning_attempts || 0) + 1;
          if (!db.students[index].messages) db.students[index].messages = [];
          const alertMsg = {
            id: 'unauth_' + Date.now(),
            text: 'تنبيه أمني هام: لقد كشف النظام محاولة دخول لصفحة التحرير وباسورد خاطئ باسمك. التكرار يعرض حسابك للطرد الفوري الحقيقي!',
            type: 'warning' as const,
            created_at: new Date().toISOString()
          };
          db.students[index].messages!.push(alertMsg);
          broadcastUpdate('student_action', 'MESSAGE', { studentId, message: alertMsg });
          broadcastUpdate('students', 'UPDATE', db.students[index]);
        }
        break;
      }
      case 'clear_intrusion_logs': {
        db.intrusion_logs = [];
        broadcastUpdate('intrusion_logs', 'UPDATE', []);
        break;
      }
      case 'pardon_student_intrusion': {
        const { studentId } = payload;
        const index = db.students.findIndex(s => s.id === studentId);
        if (index !== -1) {
          db.students[index].warning_attempts = 0;
          db.students[index].banned_until = null;
          db.students[index].banned_reason = null;
          if (!db.students[index].messages) db.students[index].messages = [];
          const pardonMsg = {
            id: 'pardon_' + Date.now(),
            text: 'تم العفو عنك من قِبل الإدارة وتصفير محاولات الاختراق ورفع الحظر عن حسابك بنجاح. يرجى الالتزام بالتعليمات.',
            type: 'congratulations' as const,
            created_at: new Date().toISOString()
          };
          db.students[index].messages!.push(pardonMsg);
          broadcastUpdate('student_action', 'MESSAGE', { studentId, message: pardonMsg });
          broadcastUpdate('students', 'UPDATE', db.students[index]);
        }
        break;
      }
      case 'add_pre_registered_code': {
        const { studentName, code, days, months, years, maxDevices } = payload;
        if (!studentName || !studentName.trim() || !code || !code.trim()) {
          res.status(400).json({ error: 'الرجاء إدخال اسم الطالب والرمز السري بشكل صحيح.' });
          return;
        }
        if (!db.pre_registered_codes) db.pre_registered_codes = [];
        const existingIdx = db.pre_registered_codes.findIndex(p => normalizeString(p.student_name) === normalizeString(studentName));
        const newCode = {
          id: 'code_' + Math.random().toString(36).substr(2, 9),
          student_name: studentName.trim(),
          code: code.trim(),
          duration_days: Number(days) || 0,
          duration_months: Number(months) || 0,
          duration_years: Number(years) || 0,
          max_devices: Number(maxDevices) || 1,
          is_used: false,
          created_at: new Date().toISOString()
        };
        if (existingIdx !== -1) {
          db.pre_registered_codes[existingIdx] = newCode;
        } else {
          db.pre_registered_codes.push(newCode);
        }
        broadcastUpdate('pre_registered_codes', 'UPDATE', db.pre_registered_codes);
        break;
      }
      case 'deduct_student_xp': {
        const { studentId, amount } = payload;
        // Deduct XP from progress
        if (db.progress) {
          db.progress.forEach((p, idx) => {
            if (p.student_id === studentId) {
              db.progress[idx].xp = Math.max(0, db.progress[idx].xp - amount);
              broadcastUpdate('progress', 'UPDATE', db.progress[idx]);
            }
          });
        }
        // notify student
        const sIndex = db.students.findIndex(s => s.id === studentId);
        if (sIndex !== -1) {
          if (!db.students[sIndex].messages) db.students[sIndex].messages = [];
          const deductMsg = {
            id: 'deduct_' + Date.now(),
            text: `⚠️ قرار تأديبي: تم خصم ${amount} من نقاط تقدمك الدراسي (XP) كعقوبة لمحاولة التعدي والقرصنة على الواجهات الأمنية للمشرف دون ترخيص!`,
            type: 'alert' as const,
            created_at: new Date().toISOString()
          };
          db.students[sIndex].messages!.push(deductMsg);
          broadcastUpdate('student_action', 'MESSAGE', { studentId, message: deductMsg });
          broadcastUpdate('students', 'UPDATE', db.students[sIndex]);
        }
        break;
      }
      case 'update_pincodes': {
        const { supervisorPin, masterPin, schoolPinCode } = payload;
        
        let supIdx = db.ui_settings.findIndex(u => u.key === 'supervisor_pin');
        if (supIdx === -1) db.ui_settings.push({ key: 'supervisor_pin', value: supervisorPin });
        else db.ui_settings[supIdx].value = supervisorPin;

        let mastIdx = db.ui_settings.findIndex(u => u.key === 'master_control_pin');
        if (mastIdx === -1) db.ui_settings.push({ key: 'master_control_pin', value: masterPin });
        else db.ui_settings[mastIdx].value = masterPin;

        let schlIdx = db.ui_settings.findIndex(u => u.key === 'school_pin_code');
        if (schlIdx === -1) db.ui_settings.push({ key: 'school_pin_code', value: schoolPinCode !== undefined ? schoolPinCode : 'awdrgyjilp' });
        else db.ui_settings[schlIdx].value = schoolPinCode !== undefined ? schoolPinCode : 'awdrgyjilp';

        broadcastUpdate('ui_settings', 'UPDATE', { supervisorPin, masterPin, schoolPinCode });
        break;
      }
      case 'delete_pre_registered_code': {
        const { codeId } = payload;
        if (!db.pre_registered_codes) db.pre_registered_codes = [];
        db.pre_registered_codes = db.pre_registered_codes.filter(p => p.id !== codeId);
        broadcastUpdate('pre_registered_codes', 'UPDATE', db.pre_registered_codes);
        break;
      }
      case 'delete_qr_code': {
        const { qrId } = payload;
        if (!db.qr_codes) db.qr_codes = [];
        db.qr_codes = db.qr_codes.filter(q => q.id !== qrId);
        broadcastUpdate('qr_codes', 'UPDATE', db.qr_codes);
        break;
      }
      case 'reset_device_lock': {
        const { codeId } = payload;
        if (db.pre_registered_codes) {
          const idx = db.pre_registered_codes.findIndex(p => p.id === codeId);
          if (idx !== -1) {
            db.pre_registered_codes[idx].registered_device_id = null;
            broadcastUpdate('pre_registered_codes', 'UPDATE', db.pre_registered_codes);
          }
        }
        break;
      }
      case 'clear_code_share_conflicts': {
        db.code_share_conflicts = [];
        broadcastUpdate('code_share_conflicts', 'UPDATE', []);
        break;
      }
      case 'clear_payment_receipts': {
        db.payment_receipts = [];
        broadcastUpdate('payment_receipts', 'UPDATE', []);
        break;
      }
      case 'clear_payment_requests': {
        db.payment_requests = [];
        broadcastUpdate('payment_requests', 'UPDATE', []);
        break;
      }
      case 'approve_payment': {
        const { requestId } = payload;
        if (!db.payment_requests) db.payment_requests = [];
        const reqIndex = db.payment_requests.findIndex(r => r.id === requestId);
        if (reqIndex !== -1) {
          const reqItem = db.payment_requests[reqIndex];
          if (reqItem.status === 'pending') {
            // Generate unique 6-digit access code
            let newCodeVal = '';
            if (!db.pre_registered_codes) db.pre_registered_codes = [];
            const existingCodes = db.pre_registered_codes.map(p => p.code);
            do {
              newCodeVal = String(Math.floor(100000 + Math.random() * 900000));
            } while (existingCodes.includes(newCodeVal));

            // Set approved state and store the code
            reqItem.status = 'approved';
            reqItem.generated_code = newCodeVal;

            // Register PreRegisteredCode
            const newPreReg = {
              id: 'code_pay_' + Math.random().toString(36).substr(2, 9),
              student_name: reqItem.student_name,
              code: newCodeVal,
              registered_device_id: null,
              created_at: new Date().toISOString()
            };
            db.pre_registered_codes.push(newPreReg);

            // Register Payment Receipt
            if (!db.payment_receipts) db.payment_receipts = [];
            const receipt = {
              id: 'receipt_' + Math.random().toString(36).substr(2, 9),
              student_name: reqItem.student_name,
              card_holder: reqItem.card_holder,
              card_digits: reqItem.card_digits,
              amount: reqItem.amount,
              generated_code: newCodeVal,
              created_at: new Date().toISOString()
            };
            db.payment_receipts.push(receipt);

            broadcastUpdate('payment_requests', 'UPDATE', db.payment_requests);
            broadcastUpdate('pre_registered_codes', 'INSERT', newPreReg);
            broadcastUpdate('payment_receipts', 'INSERT', receipt);
          }
        }
        break;
      }
      case 'reject_payment': {
        const { requestId } = payload;
        if (!db.payment_requests) db.payment_requests = [];
        const reqIndex = db.payment_requests.findIndex(r => r.id === requestId);
        if (reqIndex !== -1) {
          db.payment_requests[reqIndex].status = 'rejected';
          broadcastUpdate('payment_requests', 'UPDATE', db.payment_requests);
        }
        break;
      }
      case 'toggle_access_code': {
        const { value } = payload; // 'on' or 'off'
        let setting = db.ui_settings.find(s => s.key === 'require_access_code');
        if (setting) {
          setting.value = value;
        } else {
          db.ui_settings.push({ key: 'require_access_code', value });
        }
        broadcastUpdate('ui_settings', 'UPDATE', db.ui_settings);
        break;
      }
      case 'update_payment_card_info': {
        const { value } = payload;
        let setting = db.ui_settings.find(s => s.key === 'payment_card_info');
        if (setting) {
          setting.value = value;
        } else {
          db.ui_settings.push({ key: 'payment_card_info', value });
        }
        broadcastUpdate('ui_settings', 'UPDATE', db.ui_settings);
        break;
      }
      case 'pardon_device': {
        const { deviceId } = payload;
        if (db.device_blocks) {
          db.device_blocks = db.device_blocks.filter(d => d.device_id !== deviceId);
          broadcastUpdate('device_blocks', 'UPDATE', db.device_blocks);
        }
        break;
      }
      default:
        res.status(400).json({ error: `الحدث ${action} غير معروف لدينا.` });
        return;
    }

    writeDb(db);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'حدث خطأ أثناء إجراء تعديلات المسؤول.' });
  }
});

// AI Cup Generator via Gemini SDK
app.post('/api/cup-generator', async (req, res) => {
  const { token, textPrompt, imageBase64 } = req.body;

  if (token !== "awdrgyjilplouyking-devms-token" && token !== "awdrgyjilp-devms-token") {
    res.status(403).json({ error: "غير مصرح لك كمسؤول نظام." });
    return;
  }

  if (!ai) {
    res.status(500).json({ error: "مفتاح الذكاء الاصطناعي GEMINI_API_KEY غير مهيأ بالخادم." });
    return;
  }

  try {
    // We generate a beautiful golden cup drawing custom themed!
    const basePrompt = textPrompt || "كأس تخرج ذهبي فاخر ثلاثي الأبعاد مرصع بالياقوت الأزرق وجاذب لطلاب المدارس";
    const prompt = `صمم شعارًا أو لقطةً ترويجيةً لكأس فوز تعليمي مذهل. الخلفية يجب أن تكون شفافة أو سوداء معتمة لإضفاء هيبة ومظهر احترافي للنجاح. التفاصيل مستلهمة من: ${basePrompt}`;

    const modelName = 'gemini-2.5-flash-image';

    // If they supplied a sketched image base64, we can optionally use image-guided generation (by default fallback to text prompt)
    let response;
    if (imageBase64) {
      // Use edit mode / multimodality as outlined in Gemini-API guide
      const imageClean = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      response = await ai.models.generateContent({
        model: modelName,
        contents: {
          parts: [
            {
              inlineData: {
                data: imageClean,
                mimeType: "image/png"
              }
            },
            {
              text: `أعد صياغة وتحويل هذا التصميم التوضيحي إلى كأس أو مجسم جائزة ذهبية فاخرة ورائعة من الرخام والكريستال والذهب الخالص المضيء لمكافأة إنجاز تعليمي للطلاب. التعديل مطلوب بجودة ثلاثية أبعاد ممتازة في منتصف الصورة.`
            }
          ]
        },
        config: {
          imageConfig: {
            aspectRatio: "1:1"
          }
        }
      });
    } else {
      // Direct text prompt generation using gemini-2.5-flash-image
      response = await ai.models.generateContent({
        model: modelName,
        contents: {
          parts: [
            { text: prompt }
          ]
        },
        config: {
          imageConfig: {
            aspectRatio: "1:1"
          }
        }
      });
    }

    let generatedUrl = '';
    // Look for the image inside response parts
    if (response.candidates && response.candidates[0]?.content?.parts) {
      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const base64Data = part.inlineData.data;
          generatedUrl = `data:image/png;base64,${base64Data}`;
          break;
        }
      }
    }

    if (!generatedUrl) {
      // Generate some beautiful mock svg template if the image generator doesn't output binary in flash
      // Since sometimes flash-image responds with content, let's have a fail-safe stunning representation
      throw new Error("Could not find generated image bytes in the Gemini model candidates response.");
    }

    res.json({ url: generatedUrl });
  } catch (err: any) {
    console.error('Gemini image generation failed', err);
    res.status(500).json({ error: `حدث خطأ بالذكاء الاصطناعي: ${err.message || err}` });
  }
});

// PRIVATE SUPPORT MESSAGES API (1-on-1 text messaging)
app.get('/api/private-messages', (req, res) => {
  const { studentId } = req.query;
  if (!studentId) {
    res.status(400).json({ error: 'الرجاء تحديد معرّف الطالب.' });
    return;
  }
  const db = readDb();
  const msgs = (db.private_messages || []).filter(m => m.student_id === studentId);
  res.json(msgs);
});

app.post('/api/private-messages', (req, res) => {
  const { studentId, sender, text, token } = req.body;
  if (!studentId || !sender || !text || !text.trim()) {
    res.status(400).json({ error: 'الرجاء توفير جميع بيانات الرسالة المطلوبة.' });
    return;
  }

  // If sender is developer, verify they have the master or supervisor token
  if (sender === 'developer') {
    const supervisorPinToken = "awdrgyjilp-supervisor-token";
    const masterPinToken = "awdrgyjilplouyking-devms-token";
    if (token !== supervisorPinToken && token !== masterPinToken && token !== "awdrgyjilp-devms-token") {
      res.status(403).json({ error: "غير مصرح لك بإرسال رسائل كمسؤول." });
      return;
    }
  }

  const db = readDb();
  if (!db.private_messages) db.private_messages = [];

  const newMsg = {
    id: 'pmsg_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
    student_id: studentId,
    sender: sender as 'student' | 'developer',
    text: text.trim(),
    created_at: new Date().toISOString()
  };

  db.private_messages.push(newMsg);
  writeDb(db);

  broadcastUpdate('private_messages', 'INSERT', newMsg);
  res.json(newMsg);
});

app.delete('/api/private-messages/:id', (req, res) => {
  const { id } = req.params;
  const { userId, role } = req.query;

  const db = readDb();
  if (!db.private_messages) db.private_messages = [];

  const msgIndex = db.private_messages.findIndex(m => m.id === id);
  if (msgIndex === -1) {
    res.status(404).json({ error: 'الرسالة غير موجودة.' });
    return;
  }

  const msgObj = db.private_messages[msgIndex];

  // Developers can delete any message. Students can only delete their own.
  const isDeveloper = role === 'developer' || userId === 'developer_main';
  const isMessageOwner = msgObj.sender === 'student' && msgObj.student_id === userId;

  if (isDeveloper || isMessageOwner || (msgObj.sender === 'developer' && isDeveloper)) {
    db.private_messages.splice(msgIndex, 1);
    writeDb(db);
    broadcastUpdate('private_messages', 'DELETE', msgObj);
    res.json({ success: true, message: 'تم حذف الرسالة بنجاح.' });
  } else {
    res.status(403).json({ error: 'غير مسموح لك بحذف هذه الرسالة.' });
  }
});

// ----------------------------------------------------
// QR CODES DISCOVERY & VALIDATION API
// ----------------------------------------------------
app.get('/api/qr-details', (req, res) => {
  const { id } = req.query;
  if (!id) {
    res.status(400).json({ error: 'الرجاء توفير معرّف كود الاستجابة السريعة (QR).' });
    return;
  }
  const db = readDb();
  const qrcode = (db.qr_codes || []).find(q => q.id === id);
  if (!qrcode) {
    res.status(404).json({ error: 'كود الـ QR هذا غير متوفر أو غير مسجل بالنظام.' });
    return;
  }
  res.json(qrcode);
});

// Create and register account via Scanned QR code
app.post('/api/qr-register', (req, res) => {
  const { qrId, name, password, deviceId } = req.body;
  if (!qrId || !name || !name.trim() || !password || !password.trim()) {
    res.status(400).json({ error: 'الرجاء استكمال تعبئة جميع بيانات التسجيل لمتابعة حسابك.' });
    return;
  }

  const db = readDb();
  if (!db.qr_codes) db.qr_codes = [];
  const qrcode = db.qr_codes.find(q => q.id === qrId);

  if (!qrcode) {
    res.status(404).json({ error: 'كود الـ QR هذا غير متوفر أو صالح للاستعمال.' });
    return;
  }

  if (qrcode.is_used) {
    res.status(400).json({ error: `كود الـ QR هذا تم استخدامه مسبقاً من قِبل المشترك (${qrcode.registered_name || 'غير معروف'}) ولا يمكن استخدامه مرة أخرى.` });
    return;
  }

  // Check if name is already registered
  const nameNormalized = normalizeString(name.trim());
  const existingStud = db.students.find(s => normalizeString(s.display_name) === nameNormalized);
  if (existingStud) {
    res.status(400).json({ error: 'هذا الاسم مسجل مسبقاً في المنصة! يرجى اختيار اسم ثلاثي مختلف أو تسجيل الدخول فحسب.' });
    return;
  }

  // Calculate expiration date
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + qrcode.duration_months);

  // Create student account
  const sessionToken = 'sess_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(16);
  const newStudent = {
    id: 'student_' + Math.random().toString(36).substr(2, 9),
    display_name: name.trim(),
    created_at: new Date().toISOString(),
    banned_until: null,
    banned_reason: null,
    messages: [],
    warning_attempts: 0,
    password: password.trim(),
    session_token: sessionToken,
    entry_code: 'QR_' + qrcode.id.toUpperCase(),
    max_devices: qrcode.max_devices,
    expires_at: expiresAt.toISOString(),
    registered_devices: [deviceId || 'browser_client_dev']
  };

  // Mark QR code as used
  qrcode.is_used = true;
  qrcode.registered_student_id = newStudent.id;
  qrcode.registered_name = newStudent.display_name;

  db.students.push(newStudent);
  writeDb(db);

  // Broadcast
  broadcastUpdate('qr_codes', 'UPDATE', qrcode);
  broadcastUpdate('students', 'INSERT', newStudent);

  res.json({ student: newStudent });
});

// Generate new customized QR config
app.post('/api/qr-generate', (req, res) => {
  const { token, sectionType, maxDevices, durationMonths } = req.body;
  
  // Verify developer token
  const supervisorPinToken = "awdrgyjilp-supervisor-token";
  const masterPinToken = "awdrgyjilplouyking-devms-token";
  if (token !== supervisorPinToken && token !== masterPinToken && token !== "awdrgyjilp-devms-token") {
    res.status(403).json({ error: "غير مصرح لك بتوليد أكواد التسجيل." });
    return;
  }

  if (!sectionType || !maxDevices || !durationMonths) {
    res.status(400).json({ error: 'الرجاء توفير كافة إعدادات التسجيل لتوليد رمز الـ QR.' });
    return;
  }

  const db = readDb();
  if (!db.qr_codes) db.qr_codes = [];

  const newQR: any = {
    id: 'qr_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
    section_type: Number(sectionType),
    max_devices: Number(maxDevices),
    duration_months: Number(durationMonths),
    is_used: false,
    created_at: new Date().toISOString()
  };

  db.qr_codes.push(newQR);
  writeDb(db);

  broadcastUpdate('qr_codes', 'INSERT', newQR);
  res.json(newQR);
});

// Developer Action: Remote Logout Other Devices
app.post('/api/dev/logout-others', (req, res) => {
  const { studentId, deviceId } = req.body;
  if (!studentId || !deviceId) {
    res.status(400).json({ error: 'الرجاء تحديد معرف الحساب والجهاز المستبعد.' });
    return;
  }

  const db = readDb();
  const found = db.students.find(s => s.id === studentId);
  if (!found) {
    res.status(404).json({ error: 'المستخدم غير موجود.' });
    return;
  }

  found.registered_devices = [deviceId]; // Keep only the current device!
  writeDb(db);

  broadcastUpdate('students', 'UPDATE', found);
  res.json({ success: true, registered_devices: found.registered_devices });
});

// ----------------------------------------------------
// COMMUNITY CHAT & GROUPS API
// ----------------------------------------------------
app.get('/api/community/groups', (req, res) => {
  const db = readDb();
  res.json(db.community_groups || []);
});

app.post('/api/community/groups', (req, res) => {
  const { name, creatorId, creatorName, allowImages, allowAudio, allowVideos } = req.body;
  if (!name || !name.trim() || !creatorId || !creatorName) {
    res.status(400).json({ error: 'الرجاء توفير بيانات إنشاء المجموعة كاملة.' });
    return;
  }

  // Prevent students from creating groups completely
  if (creatorId !== 'developer_main') {
    res.status(403).json({ error: 'عذراً! المطور هو الشخص الوحيد المخول بإنشاء مجموعات وغرف الدردشة الجماعية.' });
    return;
  }

  const db = readDb();
  if (!db.community_groups) db.community_groups = [];

  const newGroup = {
    id: 'group_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
    name: name.trim(),
    creator_id: creatorId,
    creator_name: creatorName,
    is_frozen: false,
    allow_images: allowImages !== false,
    allow_audio: allowAudio !== false,
    allow_videos: allowVideos !== false,
    created_at: new Date().toISOString()
  };

  db.community_groups.push(newGroup);
  writeDb(db);

  broadcastUpdate('community_groups', 'INSERT', newGroup);
  res.json(newGroup);
});

app.put('/api/community/groups/:id', (req, res) => {
  const { id } = req.params;
  const { isFrozen, allowImages, allowAudio, allowVideos, editorId } = req.body;

  const db = readDb();
  if (!db.community_groups) db.community_groups = [];

  const grp = db.community_groups.find(g => g.id === id);
  if (!grp) {
    res.status(404).json({ error: 'المجموعة غير موجودة.' });
    return;
  }

  // Creator can edit, or if they are developer
  if (grp.creator_id !== editorId && editorId !== 'developer_main') {
    res.status(403).json({ error: 'عذراً! أنت لست مدير هذه المجموعة لتعديل إعداداتها.' });
    return;
  }

  if (isFrozen !== undefined) grp.is_frozen = isFrozen;
  if (allowImages !== undefined) grp.allow_images = allowImages;
  if (allowAudio !== undefined) grp.allow_audio = allowAudio;
  if (allowVideos !== undefined) grp.allow_videos = allowVideos;

  writeDb(db);
  broadcastUpdate('community_groups', 'UPDATE', grp);
  res.json(grp);
});

app.delete('/api/community/groups/:id', (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;

  if (!userId) {
    res.status(400).json({ error: 'من فضلك أرسل معرّف المستخدم المعتمد للقيام بالعملية.' });
    return;
  }

  // Prevent deleting the 'general' room because it's the core system default group
  if (id === 'general') {
    res.status(400).json({ error: 'عذراً! لا يمكن حذف غرفة الدردشة العامة الرئيسية للنظام.' });
    return;
  }

  const db = readDb();
  if (!db.community_groups) db.community_groups = [];

  const grpIndex = db.community_groups.findIndex(g => g.id === id);
  if (grpIndex === -1) {
    res.status(404).json({ error: 'المجموعة المطلوبة غير موجودة في قاعدة البيانات.' });
    return;
  }

  const isDev = userId === 'developer_main' || userId === (db.ui_settings?.find(s => s.key === 'dev_email')?.value || 'Developer060@gmail.com');

  if (isDev) {
    // Delete the group
    db.community_groups.splice(grpIndex, 1);
    
    // Clear its associated messages
    if (db.community_messages) {
      db.community_messages = db.community_messages.filter(m => m.group_id !== id);
    }
    
    writeDb(db);
    broadcastUpdate('community_groups', 'DELETE', { id });
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'عذراً! المطور هو الشخص الوحيد المخول بحذف المجموعات وغرف الدردشة بالكامل.' });
  }
});

app.get('/api/community/messages', (req, res) => {
  const { groupId } = req.query;
  if (!groupId) {
    res.status(400).json({ error: 'الرجاء توفير معرّف مجموعة الدردشة.' });
    return;
  }

  const db = readDb();
  const msgs = (db.community_messages || []).filter(m => m.group_id === groupId);
  res.json(msgs);
});

app.post('/api/community/messages', (req, res) => {
  const { groupId, senderId, senderName, text, image, audio, video, replyToId, replyToName, replyToText } = req.body;
  if (!groupId || !senderId || !senderName) {
    res.status(400).json({ error: 'بيانات المرسل والمجموعة مطلوبة لإرسال الرسالة.' });
    return;
  }

  const db = readDb();
  if (!db.community_messages) db.community_messages = [];

  // Check if group is frozen
  if (groupId !== 'general') {
    const grp = db.community_groups?.find(g => g.id === groupId);
    if (grp) {
      if (grp.is_frozen && grp.creator_id !== senderId) {
        res.status(403).json({ error: 'تنبيه! لقد قام مدير المجموعة بإيقاف استقبال الرسائل مؤقتاً في هذه المجموعة.' });
        return;
      }
      if (image && grp.allow_images === false && grp.creator_id !== senderId) {
        res.status(403).json({ error: 'تنبيه! لقد منع مدير المجموعة تبادل الصور داخل هذه المجموعة.' });
        return;
      }
      if (audio && grp.allow_audio === false && grp.creator_id !== senderId) {
        res.status(403).json({ error: 'تنبيه! لقد منع مدير المجموعة إرسال البصمات الصوتية داخل هذه المجموعة.' });
        return;
      }
      if (video && grp.allow_videos === false && grp.creator_id !== senderId) {
        res.status(403).json({ error: 'تنبيه! لقد منع مدير المجموعة إرسال الفيديو داخل هذه المجموعة.' });
        return;
      }
    }
  }

  const newMsg = {
    id: 'msg_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now(),
    group_id: groupId,
    sender_id: senderId,
    sender_name: senderName,
    text: (text || '').trim(),
    image_url: image || undefined,
    audio_url: audio || undefined,
    video_url: video || undefined,
    reply_to_id: replyToId || undefined,
    reply_to_name: replyToName || undefined,
    reply_to_text: replyToText || undefined,
    created_at: new Date().toISOString()
  };

  db.community_messages.push(newMsg);
  writeDb(db);

  broadcastUpdate('community_messages', 'INSERT', newMsg);
  res.json(newMsg);
});

app.delete('/api/community/messages/:id', (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;

  if (!userId) {
    res.status(400).json({ error: 'من فضلك أرسل معرّف المستخدم للحذف.' });
    return;
  }

  const db = readDb();
  if (!db.community_messages) db.community_messages = [];

  const msgIndex = db.community_messages.findIndex(m => m.id === id);
  if (msgIndex === -1) {
    res.status(404).json({ error: 'الرسالة غير موجودة.' });
    return;
  }

  const msg = db.community_messages[msgIndex];
  
  // Find group creator
  const grp = db.community_groups?.find(g => g.id === msg.group_id);
  const isSender = msg.sender_id === userId;
  const isDev = userId === 'developer_main' || userId === (db.ui_settings?.find(s => s.key === 'dev_email')?.value || 'Developer060@gmail.com');

  // strictly only the author user can delete their own message or the developer main
  if (isSender || isDev) {
    db.community_messages.splice(msgIndex, 1);
    writeDb(db);
    broadcastUpdate('community_messages', 'DELETE', { id, group_id: msg.group_id });
    res.json({ success: true });
  } else {
    res.status(403).json({ error: 'عذراً! لا تملك صلاحية حذف هذه الرسالة (يسمح بحذف رسائلك فقط أو للمطور).' });
  }
});

// Setup dev server or static file serving
async function startServer() {
  // Await bootstrapping from Cloud Firestore to ensure cached data is ready
  await initFirestoreAndDb();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Educational Tests Dev Server running at http://localhost:${PORT}`);
    
    // Stay-awake ping loop to prevent Cloud Run container scale-to-zero / inactivity deletes
    setInterval(() => {
      http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
        // successfully warmed up
      }).on('error', (err) => {
        // quiet fail on boot
      });
    }, 45 * 1000); // Poll every 45 seconds to keep instance active and in-memory cache hot
  });
}

startServer();
