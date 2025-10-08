const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// Initialize Firebase Admin (your existing code)
admin.initializeApp({
  credential: admin.credential.cert({
    type: "service_account",
    project_id: process.env.FIREBASE_PROJECT_ID || "opportunity-9d3bf",
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    universe_domain: "googleapis.com"
  }),
  databaseURL: "https://opportunity-9d3bf-default-rtdb.firebaseio.com"
});

const app = express();
const PORT = process.env.PORT || 3001;

// FIXED CORS Configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'http://localhost:3000',
      'http://localhost:3001', 
      'https://smart-fit-ar.vercel.app',
      'https://smart-fit-ar-git-main-paulos-projects-3f9d8f2a.vercel.app',
      /\.vercel\.app$/ // Allow all Vercel deployments
    ];
    
    if (allowedOrigins.some(allowedOrigin => {
      if (typeof allowedOrigin === 'string') {
        return origin === allowedOrigin;
      } else if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return false;
    })) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

app.use(express.json());

// ==================== EMPLOYEE BATCH GENERATION ====================

/**
 * Generate batch employee accounts with Firebase Auth
 */
app.post('/api/generate-employees', async (req, res) => {
  try {
    const { shopId, shopOwnerId, employeeData } = req.body;

    // Validate request
    if (!shopId || !shopOwnerId) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: shopId, shopOwnerId"
      });
    }

    // Verify shop owner exists and has permission
    const shopOwnerRef = admin.database().ref(`smartfit_AR_Database/shop/${shopOwnerId}`);
    const shopOwnerSnapshot = await shopOwnerRef.once('value');
    
    if (!shopOwnerSnapshot.exists()) {
      return res.status(403).json({
        success: false,
        error: "Shop owner not found or unauthorized"
      });
    }

    const employees = [];
    const errors = [];

    // Get count from employeeData (default to 1 if not specified)
    const count = employeeData.count || 1;
    const domain = employeeData.domain || 'yourcompany.com';
    const role = employeeData.role || 'employee';

    if (count > 50) {
      return res.status(400).json({
        success: false,
        error: "Cannot generate more than 50 employees at once"
      });
    }

    // Get the last employee number for this shop to avoid duplicates
    const lastEmployeeRef = admin.database().ref(`smartfit_AR_Database/shop/${shopId}/lastEmployeeNumber`);
    const lastEmployeeSnapshot = await lastEmployeeRef.once('value');
    let lastEmployeeNumber = lastEmployeeSnapshot.exists() ? lastEmployeeSnapshot.val() : 0;

    let createdCount = 0;
    let currentEmployeeNumber = lastEmployeeNumber + 1;

    while (createdCount < count) {
      try {
        const username = `employee${currentEmployeeNumber}`;
        const email = `${username}@${domain}`;
        const password = generatePassword();

        // Check if email already exists in Firebase Auth
        try {
          await admin.auth().getUserByEmail(email);
          // If we reach here, email exists - skip to next number
          console.log(`Email ${email} already exists, trying next number`);
          currentEmployeeNumber++;
          continue;
        } catch (error) {
          // Email doesn't exist - this is what we want
          if (error.code !== 'auth/user-not-found') {
            throw error;
          }
        }

        // Create user in Firebase Authentication
        const userRecord = await admin.auth().createUser({
          email: email,
          password: password,
          emailVerified: true,
          disabled: false
        });

        // Create employee record in Realtime Database
        const employeeRecord = {
          name: `Employee ${currentEmployeeNumber}`,
          role: role,
          permissions: employeeData.permissions || [
            'view_products',
            'manage_orders',
            'view_inventory'
          ],
          id: userRecord.uid,
          shopId: shopId,
          shopOwnerId: shopOwnerId,
          email: email,
          temporaryPassword: password,
          employeeId: `EMP${shopId.slice(-4).toUpperCase()}${currentEmployeeNumber.toString().padStart(3, '0')}`,
          status: 'active',
          dateCreated: new Date().toISOString(),
          createdBy: shopOwnerId,
          lastUpdated: new Date().toISOString(),
          isBatchGenerated: true
        };

        // Save to database
        await admin.database().ref(`smartfit_AR_Database/employees/${userRecord.uid}`).set(employeeRecord);

        // Add to shop's employees list
        await admin.database().ref(`smartfit_AR_Database/shop_employees/${shopId}/${userRecord.uid}`).set({
          employeeId: userRecord.uid,
          email: email,
          status: 'active',
          dateAdded: new Date().toISOString()
        });

        employees.push({
          uid: userRecord.uid,
          employeeId: employeeRecord.employeeId,
          email: email,
          temporaryPassword: password,
          status: 'created'
        });

        createdCount++;
        currentEmployeeNumber++;

      } catch (error) {
        if (error.code === 'auth/email-already-exists') {
          // Email exists, try next number
          console.log(`Email conflict, trying next number: ${error.message}`);
          currentEmployeeNumber++;
        } else {
          errors.push({
            employeeNumber: currentEmployeeNumber,
            error: error.message
          });
          console.error(`Failed to create employee ${currentEmployeeNumber}:`, error);
          currentEmployeeNumber++;
        }
      }
    }

    // Update the last employee number in database
    if (createdCount > 0) {
      await lastEmployeeRef.set(currentEmployeeNumber - 1);
    }

    // Log the batch creation
    await admin.database().ref(`smartfit_AR_Database/employee_batch_logs/${shopId}`).push({
      timestamp: new Date().toISOString(),
      shopOwnerId: shopOwnerId,
      countRequested: count,
      countCreated: employees.length,
      countFailed: errors.length,
      employees: employees.map(emp => ({ email: emp.email, employeeId: emp.employeeId })),
      errors: errors
    });

    res.json({
      success: true,
      message: `Successfully created ${employees.length} out of ${count} employee accounts`,
      employees: employees,
      errors: errors,
      summary: {
        totalRequested: count,
        successfullyCreated: employees.length,
        failed: errors.length
      }
    });

  } catch (error) {
    console.error('Batch employee generation error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== EMPLOYEE MANAGEMENT ====================

/**
 * Get all employees for a shop
 */
app.get('/api/shop/:shopId/employees', async (req, res) => {
  try {
    const { shopId } = req.params;
    const { shopOwnerId } = req.query; // Verify ownership

    if (!shopOwnerId) {
      return res.status(400).json({
        success: false,
        error: "shopOwnerId query parameter is required"
      });
    }

    // Verify shop owner has access to this shop
    const shopRef = admin.database().ref(`smartfit_AR_Database/shop/${shopOwnerId}`);
    const shopSnapshot = await shopRef.once('value');
    
    if (!shopSnapshot.exists()) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized access to shop employees"
      });
    }

    const employeesRef = admin.database().ref(`smartfit_AR_Database/employees`);
    const employeesSnapshot = await employeesRef.orderByChild('shopId').equalTo(shopId).once('value');

    if (!employeesSnapshot.exists()) {
      return res.json({
        success: true,
        data: []
      });
    }

    const employees = [];
    employeesSnapshot.forEach((childSnapshot) => {
      const employee = childSnapshot.val();
      // Remove sensitive data
      const { temporaryPassword, ...safeEmployeeData } = employee;
      employees.push(safeEmployeeData);
    });

    res.json({
      success: true,
      data: employees
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Update employee status (activate/deactivate)
 */
app.patch('/api/employees/:employeeId/status', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { status, shopOwnerId } = req.body;

    if (!['active', 'inactive', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status. Use: active, inactive, or suspended"
      });
    }

    // Verify employee exists and belongs to shop owner
    const employeeRef = admin.database().ref(`smartfit_AR_Database/employees/${employeeId}`);
    const employeeSnapshot = await employeeRef.once('value');

    if (!employeeSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        error: "Employee not found"
      });
    }

    const employee = employeeSnapshot.val();
    if (employee.shopOwnerId !== shopOwnerId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized to modify this employee"
      });
    }

    // Update status in database
    await employeeRef.update({
      status: status,
      lastUpdated: new Date().toISOString(),
      statusUpdatedBy: shopOwnerId
    });

    // Update status in Firebase Auth if needed
    if (status === 'suspended' || status === 'inactive') {
      await admin.auth().updateUser(employeeId, {
        disabled: true
      });
    } else {
      await admin.auth().updateUser(employeeId, {
        disabled: false
      });
    }

    res.json({
      success: true,
      message: `Employee status updated to ${status}`
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Reset employee password
 */
app.post('/api/employees/:employeeId/reset-password', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { shopOwnerId } = req.body;

    // Verify authorization
    const employeeRef = admin.database().ref(`smartfit_AR_Database/employees/${employeeId}`);
    const employeeSnapshot = await employeeRef.once('value');

    if (!employeeSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        error: "Employee not found"
      });
    }

    const employee = employeeSnapshot.val();
    if (employee.shopOwnerId !== shopOwnerId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized to reset password for this employee"
      });
    }

    const newPassword = generatePassword();
    
    // Update password in Firebase Auth
    await admin.auth().updateUser(employeeId, {
      password: newPassword
    });

    // Update temporary password in database
    await employeeRef.update({
      temporaryPassword: newPassword,
      passwordResetAt: new Date().toISOString(),
      passwordResetBy: shopOwnerId,
      lastUpdated: new Date().toISOString()
    });

    res.json({
      success: true,
      message: "Password reset successfully",
      newPassword: newPassword // Send back for distribution
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Delete employee account
 */
app.delete('/api/employees/:employeeId', async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { shopOwnerId } = req.body;

    // Verify authorization
    const employeeRef = admin.database().ref(`smartfit_AR_Database/employees/${employeeId}`);
    const employeeSnapshot = await employeeRef.once('value');

    if (!employeeSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        error: "Employee not found"
      });
    }

    const employee = employeeSnapshot.val();
    if (employee.shopOwnerId !== shopOwnerId) {
      return res.status(403).json({
        success: false,
        error: "Unauthorized to delete this employee"
      });
    }

    // Delete from Firebase Auth
    await admin.auth().deleteUser(employeeId);

    // Delete from database
    await employeeRef.remove();

    // Remove from shop employees list
    await admin.database().ref(`smartfit_AR_Database/shop_employees/${employee.shopId}/${employeeId}`).remove();

    res.json({
      success: true,
      message: "Employee account deleted successfully"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ==================== UTILITY FUNCTIONS ====================

function generatePassword(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'Employee Management API is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    success: true, 
    message: 'SmartFit Employee Backend API',
    version: '1.0.0',
    endpoints: {
      health: '/api/health',
      generateEmployees: '/api/generate-employees',
      getEmployees: '/api/shop/:shopId/employees',
      updateStatus: '/api/employees/:employeeId/status',
      resetPassword: '/api/employees/:employeeId/reset-password',
      deleteEmployee: '/api/employees/:employeeId'
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' 
      ? 'Internal server error' 
      : error.message
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

app.listen(PORT, () => {
  console.log(`Employee Management API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});