const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '10mb' })); 
app.use(cors());

// Servir arquivos estáticos da pasta public
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/$/, '') : '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL; 
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY; 
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE; 

async function fetchProfilePicture(phone) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/chat/fetchProfilePictureUrl/${EVOLUTION_INSTANCE}`,
      { number: phone },
      { headers: { 'apikey': EVOLUTION_API_KEY, 'Content-Type': 'application/json' } }
    );
    return response.data?.profilePictureUrl || response.data?.profilePicUrl || null;
  } catch (error) {
    return null;
  }
}

async function enviarMensagemWhatsApp(phone, text) {
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: phone, text: text },
      { headers: { 'apikey': EVOLUTION_API_KEY, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('Erro ao enviar mensagem automática:', error?.response?.data || error.message);
  }
}

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// --- ROTA DE CONFIGURAÇÕES GLOBAIS (LOGO, ETC) ---
app.get('/api/settings', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    const settingsMap = {};
    if (data) data.forEach(s => settingsMap[s.key] = s.value);
    res.json(settingsMap);
  } catch (error) {
    res.json({});
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    const { error } = await supabase
      .from('settings')
      .upsert({ key, value }, { onConflict: 'key' });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ROTA DE LOGIN COM RETORNO DE HIERARQUIA (ROLE) ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-mail e senha obrigatórios' });

    const { data: users, error } = await supabase.from('users').select('*').eq('email', email.trim());
    if (error || !users || users.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });

    const user = users[0];
    const storedPassword = user.password_hash || user.password;
    if (storedPassword !== password) return res.status(401).json({ error: 'Credenciais inválidas' });

    const { data: deptData } = await supabase.from('agent_departments').select('department').eq('user_id', user.id);
    const departments = deptData ? deptData.map(d => d.department) : [];

    res.status(200).json({
      success: true,
      agent: {
        id: user.id,
        name: user.name,
        email: user.email,
        departments: departments,
        role: user.role || 'agent'
      }
    });
  } catch (error) {
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
});

// --- ROTAS ADMINISTRATIVAS DE GERENCIAMENTO DE ATENDENTES ---
app.get('/api/admin/agents', async (req, res) => {
  try {
    const { data: users, error } = await supabase.from('users').select('id, name, email, role, is_active, created_at');
    if (error) throw error;

    const { data: depts } = await supabase.from('agent_departments').select('user_id, department');

    const formatted = users.map(u => ({
      ...u,
      departments: depts ? depts.filter(d => d.user_id === u.id).map(d => d.department) : []
    }));

    res.json(formatted);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/agents', async (req, res) => {
  try {
    const { name, email, password, role, departments } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Preencha os campos obrigatórios' });

    const { data: newUser, error } = await supabase
      .from('users')
      .insert([{ name, email, password_hash: password, role: role || 'agent', is_active: true }])
      .select()
      .single();

    if (error) throw error;

    if (departments && Array.isArray(departments) && departments.length > 0) {
      const depInserts = departments.map(d => ({ user_id: newUser.id, department: d }));
      await supabase.from('agent_departments').insert(depInserts);
    }

    res.status(200).json({ success: true, user: newUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/admin/agents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, departments } = req.body;

    const updateData = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (password) updateData.password_hash = password;
    if (role) updateData.role = role;

    if (Object.keys(updateData).length > 0) {
      const { error } = await supabase.from('users').update(updateData).eq('id', id);
      if (error) throw error;
    }

    if (departments && Array.isArray(departments)) {
      await supabase.from('agent_departments').delete().eq('user_id', id);
      if (departments.length > 0) {
        const depInserts = departments.map(d => ({ user_id: id, department: d }));
        await supabase.from('agent_departments').insert(depInserts);
      }
    }

    res.status(200).json({ success: true, message: 'Atendente atualizado com sucesso!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/agents/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await supabase.from('agent_departments').delete().eq('user_id', id);
    const { error } = await supabase.from('users').delete().eq('id', id);
    if (error) throw error;
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- WEBHOOK WHATSAPP ---
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { event, data } = req.body;

    if (event === 'messages.upsert') {
      const message = data;
      const remoteJid = message?.key?.remoteJid;
      const fromMe = message?.key?.fromMe;
      const text = (message?.message?.conversation || message?.message?.extendedTextMessage?.text || '').trim();
      const pushName = message?.pushName || 'Cliente';

      if (!remoteJid || remoteJid.endsWith('@g.us')) return res.status(200).send('Ignorado');
      const cleanPhone = remoteJid.replace('@s.whatsapp.net', '');

      let { data: contacts } = await supabase.from('contacts').select('id, profile_pic_url').eq('phone_number', cleanPhone);
      let contact = contacts && contacts.length > 0 ? contacts[0] : null;

      if (!contact) {
        const profilePicUrl = await fetchProfilePicture(cleanPhone);
        const { data: newC } = await supabase.from('contacts').insert([{ name: pushName, phone_number: cleanPhone, profile_pic_url: profilePicUrl }]).select('id, profile_pic_url').single();
        contact = newC;
      }

      let { data: tickets } = await supabase.from('tickets').select('id, status, department').eq('contact_id', contact.id).order('created_at', { ascending: false }).limit(1);
      let ticket = tickets && tickets.length > 0 ? tickets[0] : null;

      if (!ticket || ticket.status === 'closed') {
        // Se a mensagem partiu de você (celular), não cria ticket automático nem manda boas-vindas
        if (fromMe) {
          return res.status(200).json({ status: 'ignored_outbound_init' });
        }

        const now = new Date();
        const { data: newT, error: errNewT } = await supabase.from('tickets').insert([{ 
          contact_id: contact.id, 
          status: 'pending', 
          department: null,
          created_at: now,
          updated_at: now,
          started_at: now,
          last_message_at: now
        }]).select('id, status, department').single();

        if (errNewT) return res.status(500).json({ error: errNewT.message });
        
        ticket = newT;
        
        await enviarMensagemWhatsApp(cleanPhone, `Olá, *${pushName}*! Seja bem-vindo à Web Net! 💻✨\nEscolha o setor desejado:\n\n1️⃣ - Suporte Técnico\n2️⃣ - Financeiro\n3️⃣ - Comercial`);
        return res.status(200).json({ status: 'welcome_sent' });
      }

      if (!ticket.department) {
        // Se a mensagem partiu de você com ticket sem setor, não processa o robô
        if (fromMe) return res.status(200).json({ status: 'ignored_outbound' });

        let escolhido = text === '1' ? 'suporte' : text === '2' ? 'financeiro' : text === '3' ? 'comercial' : null;
        if (escolhido) {
          await supabase.from('tickets').update({ department: escolhido, status: 'open', updated_at: new Date(), last_message_at: new Date() }).eq('id', ticket.id);
          await enviarMensagemWhatsApp(cleanPhone, `Você foi direcionado para o setor de **${escolhido.toUpperCase()}**. Um atendente já vai lhe responder!`);
          return res.status(200).json({ status: 'dept_set' });
        } else {
          await enviarMensagemWhatsApp(cleanPhone, `Opção inválida. Digite:\n1️⃣ - Suporte Técnico\n2️⃣ - Financeiro\n3️⃣ - Comercial`);
          return res.status(200).json({ status: 'invalid' });
        }
      }

      if (!fromMe) {
        await supabase.from('messages').insert([{ ticket_id: ticket.id, sender_type: 'client', sender_name: pushName, content: text }]);
        await supabase.from('tickets').update({ updated_at: new Date(), last_message_at: new Date() }).eq('id', ticket.id);
      }
    }
    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('Erro crítico no webhook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rotas padrão de tickets
app.get('/api/tickets', async (req, res) => {
  try {
    let query = supabase.from('tickets')
      .select(`id, status, department, assigned_to, last_agent_name, created_at, updated_at, contacts(id, name, phone_number, profile_pic_url), messages(sender_name, created_at)`)
      .in('status', ['open', 'pending'])
      .order('updated_at', { ascending: false });

    const { data, error } = await query;
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ROTA DE HISTÓRICO DE TICKETS FECHADOS ---
app.get('/api/tickets/history', async (req, res) => {
  try {
    const { data: tickets, error: ticketError } = await supabase
      .from('tickets')
      .select(`id, status, department, assigned_to, last_agent_name, created_at, closed_at, updated_at, contacts(id, name, phone_number, profile_pic_url)`)
      .eq('status', 'closed')
      .order('updated_at', { ascending: false });

    if (ticketError) throw ticketError;
    if (!tickets || tickets.length === 0) return res.json([]);

    const ticketsComMensagens = await Promise.all(tickets.map(async (t) => {
      const { data: msgs } = await supabase
        .from('messages')
        .select('*')
        .eq('ticket_id', t.id)
        .order('created_at', { ascending: true });

      return {
        ...t,
        messages: msgs || []
      };
    }));

    res.json(ticketsComMensagens);
  } catch (error) {
    console.error('Erro ao carregar histórico:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/tickets/:ticketId/messages', async (req, res) => {
  const { data } = await supabase.from('messages').select('*').eq('ticket_id', req.params.ticketId).order('created_at', { ascending: true });
  res.json(data || []);
});

app.post('/api/messages/send', async (req, res) => {
  try {
    const { ticketId, phone, message, agentName } = req.body;

    await axios.post(`${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
      number: phone, text: `*${agentName || 'Atendente'}:*\n${message}`
    }, { headers: { 'apikey': EVOLUTION_API_KEY, 'Content-Type': 'application/json' } });

    await supabase.from('messages').insert([{ ticket_id: ticketId, sender_type: 'agent', sender_name: agentName || 'Atendente', content: message }]);
    
    await supabase.from('tickets').update({ 
      updated_at: new Date(), 
      last_message_at: new Date(),
      last_agent_name: agentName || 'Atendente'
    }).eq('id', ticketId);
    
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Erro detalhado ao enviar via painel:', error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- ROTA PARA TRANSFERIR O ATENDIMENTO ---
app.post('/api/tickets/:id/transfer', async (req, res) => {
  try {
    const ticketId = req.params.id;
    const { newAgentId, newAgentName, transferrerName } = req.body;

    const { error } = await supabase
      .from('tickets')
      .update({ 
        assigned_to: newAgentId, 
        last_agent_name: newAgentName,
        updated_at: new Date()
      })
      .eq('id', ticketId);

    if (error) throw error;

    await supabase.from('messages').insert([{
      ticket_id: ticketId,
      sender_type: 'system',
      sender_name: 'Sistema',
      content: `Atendimento transferido de ${transferrerName || 'um atendente'} para ${newAgentName}.`
    }]);

    res.json({ success: true, message: 'Atendimento transferido com sucesso' });
  } catch (error) {
    console.error('Erro ao transferir atendimento:', error);
    res.status(500).json({ error: 'Erro ao transferir atendimento' });
  }
});

// Rota para encerrar o ticket
app.post('/api/tickets/:ticketId/close', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { error } = await supabase.from('tickets').update({ status: 'closed', updated_at: new Date(), closed_at: new Date() }).eq('id', ticketId);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});