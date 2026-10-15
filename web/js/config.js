// Public settings for the browser. These two values are safe to publish:
// the anon key only works within the database's row-level security rules.
// Leave them empty to run the app in demo mode with sample data.
export const config = {
  supabaseUrl: '',      // e.g. 'https://abcd1234.supabase.co'
  supabaseAnonKey: '',  // Project Settings → API → anon public key
};
