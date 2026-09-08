const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

// Servir arquivos estáticos da pasta public
app.use(express.static('public'));

const supabaseUrl = process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/$/, '') : '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configurações da Evolution API vindas do .env
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL; 
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY; 
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE; 

// Função auxiliar para buscar a foto de perfil na Evolution API
async function fetchProfilePicture(phone) {
  try {
    const response = await axios.post(
      `${EVOLUTION_API_URL}/chat/fetchProfilePictureUrl/${EVOLUTION_INSTANCE}`,
      { number: phone },
      {
        headers: {
          'apikey': EVOLUTION_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data?.profilePictureUrl || response.data?.profilePicUrl || null;
  } catch (error) {
    console.log(`[Info] Não foi possível buscar foto para ${phone} (pode ser privacidade do contato).`);
    return null;
  }
}

// Função auxiliar para enviar mensagens de texto comuns via Evolution API
async function enviarMensagemWhatsApp(phone, text) {
  try {
    await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { number: phone, text: text },
      {
        headers: {
          'apikey': EVOLUTION_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
  } catch (error) {
    console.error('Erro ao enviar mensagem automática via Evolution:', error?.response?.data || error.message);
  }
}

// Rota para servir o painel visual na raiz
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// --- ROTA DE AUTENTICAÇÃO (LOGIN) COM RETORNO DOS SETORES ---
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const userName = data.user.user_metadata?.name || data.user.email.split('@')[0];

    // Busca os setores vinculados a este usuário na tabela agent_departments
    const { data: deptData } = await supabase
      .from('agent_departments')
      .select('department')
      .eq('user_id', data.user.id);

    const departments = deptData ? deptData.map(d => d.department) : [];

    res.status(200).json({
      success: true,
      agent: {
        id: data.user.id,
        name: userName,
        email: data.user.email,
        departments: departments
      },
      session: data.session
    });
  } catch (error) {
    console.error('Erro no login:', error.message);
    res.status(401).json({ error: 'Credenciais inválidas' });
  }
});

// --- ROTA DE CADASTRO DE NOVOS ATENDENTES ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios' });
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name }
    });

    if (error) throw error;

    res.status(200).json({ success: true, user: data.user });
  } catch (error) {
    console.error('Erro ao registrar usuário:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- ROTA PARA LISTAR TODOS OS ATENDENTES ---
app.get('/api/agents', async (req, res) => {
  try {
    const { data: authUsers, error: authError } = await supabase.auth.admin.listUsers();
    if (authError) throw authError;

    const { data: deptError } = await supabase
      .from('agent_departments')
      .select('user_id, department');
    if (deptError) throw deptError;

    const agents = authUsers.users.map(user => {
      const userDepts = deptError
        .filter(d => d.user_id === user.id)
        .map(d => d.department);

      return {
        id: user.id,
        name: user.user_metadata?.name || user.email.split('@')[0],
        email: user.email,
        departments: userDepts
      };
    });

    res.status(200).json(agents);
  } catch (error) {
    console.error('Erro ao listar atendentes:', error.message);
    res.status(500).json({ error: 'Erro ao carregar lista de atendentes' });
  }
});

// --- ROTA PARA ALTERAR A SENHA DE UM ATENDENTE ESPECÍFICO ---
app.put('/api/agents/:agentId/password', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }

    const { error } = await supabase.auth.admin.updateUserById(agentId, {
      password: password
    });

    if (error) throw error;

    res.status(200).json({ success: true, message: 'Senha atualizada com sucesso!' });
  } catch (error) {
    console.error('Erro ao alterar senha do atendente:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// --- ROTA PARA SALVAR/ATUALIZAR MÚLTIPLOS SETORES DO ATENDENTE ---
app.post('/api/agents/:agentId/departments', async (req, res) => {
  try {
    const { agentId } = req.params;
    const { departments } = req.body;

    if (!Array.isArray(departments)) {
      return res.status(400).json({ error: 'O formato dos setores deve ser um array' });
    }

    // Remove os vínculos antigos do atendente
    await supabase.from('agent_departments').delete().eq('user_id', agentId);

    // Insere os novos vínculos se houver itens
    if (departments.length > 0) {
      const inserts = departments.map(dept => ({ user_id: agentId, department: dept }));
      const { error: insertError } = await supabase.from('agent_departments').insert(inserts);
      if (insertError) throw insertError;
    }

    res.status(200).json({ success: true, message: 'Setores atualizados com sucesso!' });
  } catch (error) {
    console.error('Erro ao atualizar setores do agente:', error);
    res.status(500).json({ error: error.message });
  }
});

// Webhook para receber as mensagens da Evolution API com Menu de Setores e Mensagem Inicial
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const { event, data } = req.body;

    if (event === 'messages.upsert') {
      const message = data;
      const remoteJid = message?.key?.remoteJid;
      const fromMe = message?.key?.fromMe;
      const text = (message?.message?.conversation || message?.message?.extendedTextMessage?.text || '').trim();
      const pushName = message?.pushName || 'Cliente';

      if (!remoteJid || remoteJid.endsWith('@g.us')) {
        return res.status(200).send('Mensagem ignorada');
      }

      const cleanPhone = remoteJid.replace('@s.whatsapp.net', '');

      // 1. Buscar ou criar contato
      let { data: contacts, error: contactError } = await supabase
        .from('contacts')
        .select('id, profile_pic_url')
        .eq('phone_number', cleanPhone);

      if (contactError) throw contactError;

      let contact = contacts && contacts.length > 0 ? contacts[0] : null;

      if (!contact) {
        const profilePicUrl = await fetchProfilePicture(cleanPhone);
        const { data: newContact, error: insertContactError } = await supabase
          .from('contacts')
          .insert([{ name: pushName, phone_number: cleanPhone, profile_pic_url: profilePicUrl }])
          .select('id, profile_pic_url')
          .single();
          
        if (insertContactError) throw insertContactError;
        contact = newContact;
      } else if (!contact.profile_pic_url) {
        const profilePicUrl = await fetchProfilePicture(cleanPhone);
        if (profilePicUrl) {
          await supabase.from('contacts').update({ profile_pic_url: profilePicUrl }).eq('id', contact.id);
        }
      }

      // 2. Buscar ticket ATIVO (open ou pending) do contato para reutilizá-lo sempre na mesma conversa
      let { data: tickets, error: ticketError } = await supabase
        .from('tickets')
        .select('id, status, department, assigned_to')
        .eq('contact_id', contact.id)
        .in('status', ['open', 'pending'])
        .order('created_at', { ascending: false })
        .limit(1);

      if (ticketError) throw ticketError;

      let ticket = tickets && tickets.length > 0 ? tickets[0] : null;

      // Se não existe ticket ativo, vamos checar se existe algum fechado ou criar um novo
      if (!ticket) {
        const { data: newTicket, error: insertTicketError } = await supabase
          .from('tickets')
          .insert([{ contact_id: contact.id, status: 'pending', department: null }])
          .select('id, status, department, assigned_to')
          .single();

        if (insertTicketError) throw insertTicketError;
        ticket = newTicket;

        // Envia a mensagem de boas-vindas inicial ANTES de pedir o setor
        const saudacaoInicial = `Olá, *${pushName}*! Seja bem-vindo à Web Net! 💻✨\nPara agilizar o seu atendimento, por favor, escolha o setor desejado respondendo com o número:\n\n1️⃣ - Suporte Técnico\n2️⃣ - Financeiro\n3️⃣ - Comercial`;
        await enviarMensagemWhatsApp(cleanPhone, saudacaoInicial);

        return res.status(200).json({ status: 'welcome_sent' });
      }

      // Se o ticket existe mas ainda NÃO tem um departamento definido (cliente está respondendo ao menu)
      if (!ticket.department) {
        let escolhido = null;
        if (text === '1') escolhido = 'suporte';
        else if (text === '2') escolhido = 'financeiro';
        else if (text === '3') escolhido = 'comercial';

        if (escolhido) {
          await supabase
            .from('tickets')
            .update({ department: escolhido })
            .eq('id', ticket.id);

          // Mensagem personalizada de boas-vindas do setor escolhido
          let msgSetor = '';
          if (escolhido === 'suporte') {
            msgSetor = `Você foi direcionado para o **Suporte Técnico** 🔧. Por favor, descreva o seu problema ou envie prints para que um de nossos técnicos possa lhe ajudar em instantes.`;
          } else if (escolhido === 'financeiro') {
            msgSetor = `Você foi direcionado para o **Financeiro** 💰. Informe o seu CPF/CNPJ ou o assunto referente a faturas e pagamentos.`;
          } else if (escolhido === 'comercial') {
            msgSetor = `Você foi direcionado para o **Comercial** 📈. Como podemos ajudar você com nossos planos e serviços de tecnologia hoje?`;
          }

          await enviarMensagemWhatsApp(cleanPhone, msgSetor);

          console.log(`[Webhook] Cliente ${pushName} escolheu o setor: ${escolhido}`);
          return res.status(200).json({ status: 'department_set' });
        } else {
          const menuInvalido = `Opção inválida. Por favor, digite o número correspondente ao setor:\n\n1️⃣ - Suporte Técnico\n2️⃣ - Financeiro\n3️⃣ - Comercial`;
          await enviarMensagemWhatsApp(cleanPhone, menuInvalido);
          return res.status(200).json({ status: 'invalid_option' });
        }
      }

      // 3. Inserir a mensagem comum na tabela messages se o fluxo de menu já passou
      if (!fromMe) {
        const { error: insertMsgError } = await supabase.from('messages').insert([
          {
            ticket_id: ticket.id,
            sender_type: 'client',
            sender_name: pushName,
            content: text,
            whatsapp_message_id: message?.key?.id
          }
        ]);
        if (insertMsgError) throw insertMsgError;
      }

      console.log(`[Webhook] Mensagem de ${pushName} salva no ticket ${ticket.id}!`);
    }

    res.status(200).json({ status: 'success' });
  } catch (error) {
    console.error('[Webhook Critical Error]:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// --- ROTAS DO PAINEL ---

// 1. Listar tickets com restrição RIGOROSA por setores permitidos ao atendente
app.get('/api/tickets', async (req, res) => {
  try {
    const { department, agentId } = req.query;
    
    let allowedDepts = [];
    if (agentId) {
      const { data: deptData } = await supabase
        .from('agent_departments')
        .select('department')
        .eq('user_id', agentId);
      
      allowedDepts = deptData ? deptData.map(d => d.department) : [];
    }

    let query = supabase
      .from('tickets')
      .select(`
        id,
        status,
        department,
        assigned_to,
        created_at,
        contacts (
          id,
          name,
          phone_number,
          profile_pic_url
        )
      `)
      .order('created_at', { ascending: false });

    if (department) {
      if (agentId && !allowedDepts.includes(department)) {
        return res.json([]);
      }
      query = query.eq('department', department);
    } else if (agentId) {
      if (allowedDepts.length > 0) {
        query = query.or(`department.in.(${allowedDepts.join(',')}),department.is.null`);
      } else {
        query = query.is('department', null);
      }
    }

    const { data, error } = await query;
    if (error) throw error;

    // Buscar nomes dos atendentes no Supabase Auth
    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const usersMap = {};
    if (authUsers && authUsers.users) {
      authUsers.users.forEach(u => {
        usersMap[u.id] = u.user_metadata?.name || u.email.split('@')[0];
      });
    }

    const ticketsWithAgents = data.map(ticket => {
      let agentName = null;
      if (ticket.assigned_to && usersMap[ticket.assigned_to]) {
        agentName = usersMap[ticket.assigned_to];
      }
      
      return {
        ...ticket,
        agents: agentName ? { name: agentName } : null
      };
    });

    res.json(ticketsWithAgents);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Listar mensagens de um ticket
app.get('/api/tickets/:ticketId/messages', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { agentId } = req.query;

    if (agentId) {
      const { data: ticketData } = await supabase
        .from('tickets')
        .select('department')
        .eq('id', ticketId)
        .single();

      if (ticketData && ticketData.department) {
        const { data: deptData } = await supabase
          .from('agent_departments')
          .select('department')
          .eq('user_id', agentId);

        const allowedDepts = deptData ? deptData.map(d => d.department) : [];
        if (!allowedDepts.includes(ticketData.department)) {
          return res.status(403).json({ error: 'Acesso negado a este setor' });
        }
      }
    }

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('ticket_id', ticketId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (error) {
    console.error('Erro ao buscar mensagens:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- ROTA PARA ATUALIZAR O SETOR MANUALMENTE E AVISAR O CLIENTE ---
app.post('/api/tickets/:ticketId/department', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { department, phone } = req.body;

    if (!department || !phone) {
      return res.status(400).json({ error: 'Setor e telefone são obrigatórios' });
    }

    const { data, error } = await supabase
      .from('tickets')
      .update({ department: department })
      .eq('id', ticketId)
      .select()
      .single();

    if (error) throw error;

    const mensagemAviso = `Você foi transferido para o setor de *${department.toUpperCase()}*. Um de nossos atendentes já irá lhe atender!`;
    await enviarMensagemWhatsApp(phone, mensagemAviso);

    res.status(200).json({ success: true, ticket: data });
  } catch (error) {
    console.error('Erro ao transferir setor:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Vincular (Assumir) ou Transferir um ticket para um atendente
app.post('/api/tickets/:ticketId/assign', async (req, res) => {
  try {
    const { ticketId } = req.params;
    const { agentId } = req.body;

    if (!agentId) {
      return res.status(400).json({ error: 'ID do atendente é obrigatório' });
    }

    const { data, error } = await supabase
      .from('tickets')
      .update({ assigned_to: agentId, status: 'open' })
      .eq('id', ticketId)
      .select()
      .single();

    if (error) throw error;
    res.status(200).json({ success: true, ticket: data });
  } catch (error) {
    console.error('Erro ao assumir/transferir ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

// --- NOVA ROTA: ENCERRAR ATENDIMENTO ---
app.post('/api/tickets/:ticketId/close', async (req, res) => {
  try {
    const { ticketId } = req.params;

    const { data, error } = await supabase
      .from('tickets')
      .update({ status: 'closed' })
      .eq('id', ticketId)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({ success: true, message: 'Atendimento encerrado com sucesso!', ticket: data });
  } catch (error) {
    console.error('Erro ao encerrar ticket:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Enviar mensagem de resposta pelo painel via Evolution API
app.post('/api/messages/send', async (req, res) => {
  try {
    const { ticketId, phone, message, agentName, agentId } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'Telefone e mensagem são obrigatórios' });
    }

    if (agentId && ticketId) {
      const { data: ticketData } = await supabase
        .from('tickets')
        .select('department')
        .eq('id', ticketId)
        .single();

      if (ticketData && ticketData.department) {
        const { data: deptData } = await supabase
          .from('agent_departments')
          .select('department')
          .eq('user_id', agentId);

        const allowedDepts = deptData ? deptData.map(d => d.department) : [];
        if (!allowedDepts.includes(ticketData.department)) {
          return res.status(403).json({ error: 'Você não tem permissão para responder neste setor' });
        }
      }
    }

    const operador = agentName || 'Web Net';
    const textoFormatado = `*${operador}:*\n${message}`;

    const evolutionResponse = await axios.post(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      {
        number: phone,
        text: textoFormatado
      },
      {
        headers: {
          'apikey': EVOLUTION_API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );

    await supabase.from('messages').insert([
      {
        ticket_id: ticketId,
        sender_type: 'agent',
        sender_name: operador,
        content: message,
        whatsapp_message_id: evolutionResponse.data?.key?.id || null
      }
    ]);

    res.status(200).json({ success: true, data: evolutionResponse.data });
  } catch (error) {
    const errorDetails = error?.response?.data || error.message;
    console.error('❌ ERRO DETALHADO EVOLUTION:', JSON.stringify(errorDetails, null, 2));
    res.status(500).json({ error: errorDetails });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});