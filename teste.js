require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

console.log("--- TESTE DE CONFIGURAÇÃO ---");
console.log("SUPABASE_URL:", process.env.SUPABASE_URL);
console.log("SUPABASE_KEY existe?", !!process.env.SUPABASE_SERVICE_ROLE_KEY);

const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.trim().replace(/\/$/, '') : '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.trim() : '';

const supabase = createClient(supabaseUrl, supabaseKey);

async function testarConexao() {
  try {
    const { data, error } = await supabase.from('contacts').select('*').limit(1);
    if (error) {
      console.error("Erro retornado pelo Supabase no teste:", error);
    } else {
      console.log("Conexão bem-sucedida! Dados encontrados:", data);
    }
  } catch (err) {
    console.error("Erro crítico na execução do teste:", err);
  }
}

testarConexao();